
// import { dbCachedZ, getFromDb } from '../db.js'
import { delay } from "../Common/parallel.js";
import { logs, normalizeName, VException } from "../Common/utils.js";
import { getPageText } from "./getpagetext.js";
import fs from "fs/promises";

// These key numbers are stored in the database.
// If we want to change a question, best use a new number.

const CATEGORIZE_PROMPT = {
      version: 3,
      text: "After the \"BEGINPAGE\" below is text from a webpage. if it's describing an event (such as a competition, gathering, festival, or celebration), say \"single\". if it's describing multiple unrelated events, say \"multiple\". If it's not describing any events at all, say \"nothing\". Do not say anything else. Your answer should only ever have one word (\"single\", \"multiple\", or \"nothing\"), and nothing else.",
      preferredModel: "gpt-3.5-turbo",
      maxTokens: 10
    };

const SUMMARIZE_PROMPT = {
      version: 6,
      text: "After the \"BEGINPAGE\" below is a webpage describing an event. please give me a paragraph of max 20 sentences describing it, including the event's name, city, state, whether it happens every year, what month it's on, the first date of the event, most recent date of the event, future date of the event, the year it ended, anything surprising about it, and anything that makes it particularly unique or interesting.",
      preferredModel: "gpt-3.5-turbo",
      maxTokens: null
    };

const YEAR_QUESTION =
    {
      text: "does the event happen every year? Answer only \"yes\", \"no\", or if not known then \"unknown\".",
      maxTokens: 2,
      preferredModel: "gpt-3.5-turbo",
      cleaner: getStartBoolOrNull
    };
const NAME_QUESTION = {
      text: "what's the event's name? Answer only the name, or \"unknown\" if not known.",
      maxTokens: 30,
      preferredModel: "gpt-3.5-turbo",
      cleaner: x => x
    };
const CITY_QUESTION = {
      text: "what city is the event held in? Answer only the city, or \"unknown\" if not known.",
      maxTokens: 10,
      preferredModel: "gpt-3.5-turbo",
      cleaner: x => x
    };
const STATE_QUESTION = {
      text: "what state is the event held in? Answer only the state's name, or \"unknown\" if not known.",
      maxTokens: 10,
      preferredModel: "gpt-3.5-turbo",
      cleaner: x => x
    };
const FIRST_DATE_QUESTION = {
      text: "when did the event first happen? Be concise. say \"unknown\" if not known.",
      maxTokens: 10,
      preferredModel: "gpt-3.5-turbo",
      cleaner: extractDateOrNull
    };
const LAST_DATE_QUESTION = {
      text: "when was the last event? Be concise. say \"unknown\" if not known.",
      maxTokens: 10,
      preferredModel: "gpt-3.5-turbo",
      cleaner: extractDateOrNull
    };
const CANCELED_QUESTION = {
      text: "was the event discontinued or permanently canceled? Answer only \"yes\" or \"no\" or \"unknown\".",
      maxTokens: 2,
      preferredModel: "gpt-3.5-turbo",
      cleaner: getStartBoolOrNull
    };
const NEXT_DATE_QUESTION = {
      text: "when will the event happen again? Be concise: answer only the date, or \"unknown\" if not known.",
      maxTokens: 10,
      preferredModel: "gpt-3.5-turbo",
      cleaner: extractDateOrNull
    };
const MONTH_QUESTION = {
      text: "what month does the event happen on? Answer only the month, or \"unknown\" if not known.",
      maxTokens: 5,
      preferredModel: "gpt-3.5-turbo",
      cleaner: extractMonthOrNull
    };
const SUMMARY_QUESTION = {
      text: "what's a one-sentence description of the event?",
      maxTokens: 100,
      preferredModel: "gpt-3.5-turbo",
      cleaner: x => x
    };
const UNUSUAL_QUESTION = {
      text: "what's the most unique, unusual, or surprising thing about the event?",
      maxTokens: 100,
      preferredModel: "gpt-3.5-turbo",
      cleaner: x => x
    };
const MULTIPLE_EVENTS_QUESTION = {
      text: "does the description describe multiple unrelated events? Answer only \"yes\" or \"no\" or \"unknown\".",
      maxTokens: 2,
      preferredModel: "gpt-3.5-turbo",
      cleaner: getStartBoolOrNull
    };

function extractDateOrNull(x) {
  const match =
    /.*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d+)(?:st|th|rd|nd)?,?\s+(\d+).*/i
    .exec(x);
  if (match && match.length > 1) {
    return match[1] + " " + match[2] + " " + match[3];
  }
  return null;
}

function startsWithUnknown(line) {
	return /unknown/i.test(line);
}
function startsWithYes(line) {
  return /yes/i.test(line);
}
function startsWithTrue(line) {
  return /true/i.test(line);
}
function startsWithNo(line) {
  return /no/i.test(line);
}
function startsWithFalse(line) {
  return /false/i.test(line);
}
function getStartBoolOrNull(line) {
	if (startsWithUnknown(line)) {
		return null;
	} else if (startsWithYes(line) || startsWithTrue(line)) {
		return true;
	} else if (startsWithNo(line) || startsWithFalse(line)) {
		return false;
	} else {
		return null;
	}
}
function isKnownTrueOrNull(line) {
	if (line == "" || startsWithUnknown(line)) {
		return null;
	} else {
		return true;
	}
}
function getMonthOrNull(month_response) {
	const match =
		/(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)/i.exec(month_response);
	return (match && match.length > 1 && match[1]) || null;
}
function extractMonthOrNull(month_response) {
  const match =
    /.*(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?).*/i.exec(month_response);
  return (match && match.length > 1 && match[1]) || null;
}

export async function analyzePageOuter(
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    chromeFetcher,
    chromeCacheCounter,
    modelToLlmRequester,
    retryErrors,
    throttlerPriority,
    gptCacheCounter,
    overrideModel,
    event_i,
    matchName,
    matchCity,
    matchState,
    maybeIdForLogging,
    broadSteps,
    search_result_i,
    url) {
  // We declare these up here so that the try block's exception can include them.
  let pageSteps = [];
  let matchSteps = [];
  let pageText = null;
  let pageTextError = null;
  let analysis = null;
  let pageAnalysisStatus = null;
  let matchAnalysisStatus = null;

  try {
    await db.transaction(async (trx) => {
      const maybePageAnalysisRow = await trx.getPageAnalysis(url);
      if (maybePageAnalysisRow) {
        pageAnalysisStatus = maybePageAnalysisRow.status;
        pageSteps = maybePageAnalysisRow.steps || [];
      }
      if (pageAnalysisStatus == null) {
        logs(pageSteps, broadSteps)("Starting analysis for page:", url);
        await trx.startPageAnalysis(url);
        pageAnalysisStatus = 'created';
      } else if (pageAnalysisStatus == 'created') {
        console.log("Resuming existing page analysis row for:", url);
      } else {
        console.log("Page analysis already finished for url:", url, "but proceeding.");
      }
    });

    // Sanity check
    if (!await db.getPageAnalysis(url)) {
      throw logs(pageSteps)("No analysis to use?!");
    }

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, retryErrors, maybeIdForLogging, pageSteps, event_i, search_result_i, url);
    pageText = pageText_ && pageText_.replace(/\s+/g, ' ');
    pageTextError = pageTextError_;

    if (pageTextError) {
      throw logs(pageSteps, broadSteps)("Bad pdf-to-text. Error:", pageTextError);
    }
    if (!pageText) {
      // This actually shouldnt happen, there's a check in getPageText.
      throw logs(pageSteps, broadSteps)("Seemingly successful pdf-to-text, but no page text and no error!");
    }

    const {status: describeStatus, description, error: describeError} =
        await describePage(
            db,
            gptCacheCounter,
            modelToLlmRequester,
            throttlerPriority,
            pageSteps,
            overrideModel,
            maybeIdForLogging,
            url,
            pageText);
    if (describeStatus == 'error') {
      logs(pageSteps, broadSteps)("Describe had errors, marking analysis errors:", describeError);
      await db.finishPageAnalysis(url, 'errors', pageSteps, null);
      return;
    } else if (describeStatus == 'rejected') {
      logs(pageSteps, broadSteps)("Describe rejected, marking analysis rejected:", describeError);
      await db.finishPageAnalysis(url, 'rejected', pageSteps, null);
      return;
    } else if (describeStatus == 'success') {
      // Proceed
    } else {
      throw logs(pageSteps, broadSteps)("Bad status wtf:", describeStatus, description, describeError);
    }

    const {status: analyzeInnerStatus, analysis} =
        await analyzePageInner(
            db,
            gptCacheCounter,
            modelToLlmRequester,
            throttlerPriority,
            retryErrors,
            pageSteps,
            overrideModel,
            maybeIdForLogging,
            url,
            description,
            matchName ? makeMatchQuestions(matchName, matchState, matchCity) : []);

    if (analyzeInnerStatus == 'created') {
      console.log("Inner analyze status created, marking page analysis created.");
      await db.finishPageAnalysis(url, 'created', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'errors') {
      logs(pageSteps, broadSteps)("Inner analyze had errors, marking analysis errors.");
      await db.finishPageAnalysis(url, 'errors', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'rejected') {
      logs(pageSteps, broadSteps)("Inner analyze rejected, rejecting analysis.");
      await db.finishPageAnalysis(url, 'rejected', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'success') {
      console.log("Inner analyze status success, marking page analysis success.");
      await db.finishPageAnalysis(url, 'success', pageSteps, analysis);
    } else {
      throw logs(broadSteps)("Wat analyze response:", analysis, analyzeInnerStatus)
    }

    // sanity check
    if (!await db.getPageAnalysis(url)) {
      throw logs(pageSteps)("No analysis to use?!");
    }

  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(pageSteps, broadSteps)("analyzePageOuter error:", error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishPageAnalysis(url, 'errors', pageSteps, analysis);
  }
}

export async function analyzeMatchOuter(
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    chromeFetcher,
    chromeCacheCounter,
    modelToLlmRequester,
    retryErrors,
    throttlerPriority,
    gptCacheCounter,
    submissionId,
    overrideModel,
    event_i,
    matchName,
    matchCity,
    matchState,
    broadSteps,
    search_result_i,
    url) {
  // We declare these up here so that the try block's exception can include them.
  let matchSteps = [];
  let pageText = null;
  let pageTextError = null;
  let matchStatus = null;
  let matchness = null;

  if (!matchName || !matchCity || !matchState) {
    throw logs(broadSteps)("Must have all of matchName, matchCity, and matchState.");
  }

  try {
    await db.transaction(async (trx) => {
      const matchRow = await trx.getMatchAnalysis(submissionId, url);
      if (matchRow) {
        matchStatus = matchRow.status;
        matchSteps = matchRow.steps || [];
      }
      if (matchStatus == null) {
        logs(matchSteps, broadSteps)("Starting analysis for match:", url, matchName, matchCity, matchState);
        await trx.startMatchAnalysis(submissionId, url);
        matchStatus = 'created';
      } else if (matchStatus == 'created') {
        console.log("Resuming existing page analysis row for:", url, matchName, matchCity, matchState);
      } else {
        console.log("Match analysis already finished for url:", url, matchName, matchCity, matchState, "but proceeding.");
      }
    });

    // Sanity check
    if (!await db.getMatchAnalysis(submissionId, url)) {
      throw logs(matchSteps)("No analysis to use?!");
    }

    // Now, make sure a page analysis exists for this match analysis.

    // This will update the rows in the database.
    await analyzePageOuter(
        scratchDir,
        db,
        googleSearchApiKey,
        fetchThrottler,
        searchThrottler,
        searchCacheCounter,
        chromeFetcher,
        chromeCacheCounter,
        modelToLlmRequester,
        retryErrors,
        throttlerPriority,
        gptCacheCounter,
        overrideModel,
        event_i,
        matchName,
        matchCity,
        matchState,
        submissionId,
        broadSteps,
        search_result_i,
        url);
    const pageAnalysisRow = await db.getPageAnalysis(url);
    if (pageAnalysisRow.status == 'created') {
      await db.finishMatchAnalysis(submissionId, url, 'created', matchSteps, matchness);
      return;
    } else if (pageAnalysisRow.status == 'errors') {
      logs(matchSteps, broadSteps)({"": "Error from page analysis, stopping match analysis.", pageAnalysis: pageAnalysisRow});
      await db.finishMatchAnalysis(submissionId, url, 'errors', matchSteps, matchness);
      return;
    } else if (pageAnalysisRow.status == 'rejected') {
      logs(matchSteps, broadSteps)({"": "Page analysis rejected, rejecting match analysis."});
      await db.finishMatchAnalysis(submissionId, url, 'rejected', matchSteps, matchness);
      return;
    } else if (pageAnalysisRow.status == 'success') {
      // Proceed
    } else {
      throw "Weird status from page analysis: " + pageAnalysisRow.status;
    }


    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, retryErrors, submissionId, matchSteps, event_i, search_result_i, url);
    pageText = pageText_;
    pageTextError = pageTextError_;

    if (pageTextError) {
      throw logs(matchSteps, broadSteps)("Bad pdf-to-text. Error:", pageTextError);
    }
    if (!pageText) {
      // This actually shouldnt happen, there's a check in getPageText.
      throw logs(matchSteps, broadSteps)("Seemingly successful pdf-to-text, but no page text and no error!");
    }

    matchness =
        await analyzeMatchInner(
            db,
            gptCacheCounter,
            modelToLlmRequester,
            throttlerPriority,
            retryErrors,
            matchSteps,
            overrideModel,
            submissionId,
            url,
            pageText,
            matchName,
            matchCity,
            matchState);

    // if (matchInnerStatus == 'created') {
    //   console.log("Inner analyze status created, marking match analysis created.");
    //   await db.finishMatchAnalysis(submissionId, url, model, 'created', matchSteps, matchness);
    // } else if (matchInnerStatus == 'errors') {
    //   logs(matchSteps, broadSteps)("Inner analyze had errors, marking analysis errors.");
    //   await db.finishMatchAnalysis(submissionId, url, model, 'errors', matchSteps, matchness);
    // } else if (matchInnerStatus == 'rejected') {
    //   logs(matchSteps, broadSteps)("Inner analyze rejected, wasn't an event, rejecting analyses.");
    //   await db.finishMatchAnalysis(submissionId, url, model, 'errors', matchSteps, matchness);
    // } else if (matchInnerStatus == 'success') {
    //   console.log("Inner analyze status created, marking match analysis success.");
    //   // Proceed
    // } else {
    //   throw logs(broadSteps)("Wat analyze response:", matchness, matchInnerStatus)
    // }

    logs(matchSteps, broadSteps)("Matchness calculation successful for page", url, "matchness", matchness);
    await db.finishMatchAnalysis(submissionId, url, 'success', matchSteps, matchness);

    // sanity check
    if (!await db.getMatchAnalysis(submissionId, url)) {
      throw logs(matchSteps)("No match analysis to use?!");
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(matchSteps, broadSteps)("analyzeMatchOuter error:", error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishMatchAnalysis(submissionId, url, 'errors', matchSteps, matchness);
  }
}

// Returns:
// - How closely it matches.
//   - 0: not event.
//   - 1: not same event.
//   - 2: same event somewhere.
//   - 3: same event same state.
//   - 4: same event same city.
//.  - 5: multiple events.
// - information about the event, or null if not an event.
// - status: created if paused, errors if any errors, success if success
export async function analyzePageInner(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    retryErrors,
    steps,
    overrideModel,
    maybeIdForLogging,
    url,
    description,
    extraStowawayQuestions) {
  if (steps == null) {
    throw "Steps null wtf";
  }

	let questions = [
		MULTIPLE_EVENTS_QUESTION,
		YEAR_QUESTION,
		NAME_QUESTION,
		CITY_QUESTION,
		STATE_QUESTION,
		FIRST_DATE_QUESTION,
		LAST_DATE_QUESTION,
    CANCELED_QUESTION,
		NEXT_DATE_QUESTION,
		MONTH_QUESTION,
		SUMMARY_QUESTION,
    UNUSUAL_QUESTION
	];
  if (extraStowawayQuestions) {
    questions = questions.concat(extraStowawayQuestions);
  }

  const questionToAnswer =
      await askQuestionsForPageOuter(
          db,
          gptCacheCounter,
          modelToLlmRequester,
          throttlerPriority,
          retryErrors,
          steps,
          overrideModel,
          maybeIdForLogging,
          url,
          description,
          questions);

	const analysis = {
		yearly: null,
		name: null,
		city: null,
		state: null,
		month: null,
		firstDate: null,
		lastDate: null,
		nextDate: null,
		summary: null,
		description: description
	};

  logs(steps)("Considering answers...", questionToAnswer);

	const multipleEventsAnswer = getStartBoolOrNull(questionToAnswer[MULTIPLE_EVENTS_QUESTION.text]);
	if (multipleEventsAnswer === true) {
    logs(steps)("Multiple events, rejecting.");
    return {status: "rejected", analysis: null};
	}

	const cityAnswer = questionToAnswer[CITY_QUESTION.text];
	analysis.city = isKnownTrueOrNull(cityAnswer) && cityAnswer;
  
	const stateAnswer = questionToAnswer[STATE_QUESTION.text];
	analysis.state = isKnownTrueOrNull(stateAnswer) && stateAnswer;

  const nameAnswer = questionToAnswer[NAME_QUESTION.text];
  analysis.name = isKnownTrueOrNull(nameAnswer) && nameAnswer;
  if (analysis.name && analysis.city && analysis.state) {
    analysis.name = normalizeName(analysis.name, analysis.city, analysis.state);
  }
  if (!analysis.name) {
    logs(steps)("Couldn't find name from page, rejecting.");
    return {status: "rejected", analysis};
  }

  const summaryAnswer = questionToAnswer[SUMMARY_QUESTION.text];
  analysis.summary = isKnownTrueOrNull(summaryAnswer) && summaryAnswer;
  if (!analysis.summary || analysis.summary.length < 20) {
    logs(steps)("Error, summary missing or too short:", summaryAnswer);
    return {status: "errors", analysis};
  }

  const unusualAnswer = questionToAnswer[UNUSUAL_QUESTION.text];
  analysis.unusual = isKnownTrueOrNull(unusualAnswer) && unusualAnswer;

  const yearAnswer = getStartBoolOrNull(questionToAnswer[YEAR_QUESTION.text]);
  analysis.yearly = yearAnswer;

	const firstDateAnswer = questionToAnswer[FIRST_DATE_QUESTION.text];
	analysis.firstDate = isKnownTrueOrNull(firstDateAnswer) && firstDateAnswer;

	const lastDateAnswer = questionToAnswer[LAST_DATE_QUESTION.text];
	analysis.lastDate = isKnownTrueOrNull(lastDateAnswer) && lastDateAnswer;

  const canceledAnswer = getStartBoolOrNull(questionToAnswer[CANCELED_QUESTION.text]);
  analysis.canceled = isKnownTrueOrNull(canceledAnswer) && canceledAnswer;

	const nextDateAnswer = questionToAnswer[NEXT_DATE_QUESTION.text];
	analysis.nextDate = isKnownTrueOrNull(nextDateAnswer) && nextDateAnswer;

	const monthAnswer = questionToAnswer[MONTH_QUESTION.text];
	analysis.month = isKnownTrueOrNull(monthAnswer) && getMonthOrNull(monthAnswer);

  logs(steps)("Analysis complete, success:", analysis.name, analysis.city, analysis.state, analysis.summary);
	return {status: "success", analysis};
}

function makeMatchQuestions(matchName, matchState, matchCity) {
  const arr = [];
  arr.push({
    text: "is it primarily referring to or describing or talking about the " + matchName + " event? Answer only \"yes\" or \"no\".",
    maxTokens: 1,
    preferredModel: 'gpt-3.5-turbo',
    cleaner: getStartBoolOrNull
  });
  if (matchState) {
    arr.push({
      text: "is it primarily referring to or describing or talking about the " + matchName + " event in " + matchState + "? Answer only \"yes\" or \"no\".",
      maxTokens: 1,
      preferredModel: 'gpt-3.5-turbo',
      cleaner: getStartBoolOrNull
    });
  }
  if (matchState && matchCity) {
    arr.push({
      text: "is it primarily referring to or describing or talking about the " + matchName + " event in " + matchCity + ", " + matchState + "? Answer only \"yes\" or \"no\".",
      maxTokens: 1,
      preferredModel: 'gpt-3.5-turbo',
      cleaner: getStartBoolOrNull
    });
  }
  return arr;
}

// Returns how closely it matches.
// - 0: not event.
// - 1: not same event.
// - 2: same event somewhere.
// - 3: same event same state.
// - 4: same event same city.
// - 5: multiple events.
export async function analyzeMatchInner(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    retryErrors,
    steps,
    overrideModel,
    submissionId,
    url,
    description,
    matchName,
    matchCity,
    matchState) {
  if (steps == null) {
    throw "Steps null wtf";
  }

  const questions = makeMatchQuestions(matchName, matchState, matchCity);
  const [matchesAnywhereQuestion, matchesStateQuestion, matchesCityQuestion] = questions;

  const questionToAnswer =
      await askQuestionsForPageOuter(
          db,
          gptCacheCounter,
          modelToLlmRequester,
          throttlerPriority,
          retryErrors,
          steps,
          overrideModel,
          submissionId,
          url,
          description,
          questions);

  logs(steps)({"": "Considering answers...", "details": questionToAnswer });

  let matchness = 1;
  const matchesAnywhereAnswer = questionToAnswer[matchesAnywhereQuestion.text];
  const matchesAnywhere = getStartBoolOrNull(matchesAnywhereAnswer);
  if (matchesAnywhere) {
    logs(steps)("Matches somewhere!");
    matchness = 2;
    
    if (matchState) {
      const matchesStateAnswer = questionToAnswer[matchesStateQuestion.text];
      const matchesState = getStartBoolOrNull(matchesStateAnswer);
      if (matchesState) {
        logs(steps)("Matches state!");
        matchness = 3;

        
        if (matchState && matchCity) {
          const matchesCityAnswer = questionToAnswer[matchesCityQuestion.text];
          const matchesCity = getStartBoolOrNull(matchesCityAnswer);
          if (matchesCity) {
            logs(steps)("Matches city!");
            matchness = 4;
          }
        }
      }
    }
  }

  return matchness;
}

// Returns a {status, description, error}
export async function describePage(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    steps,
    overrideModel,
    maybeIdForLogging,
    url,
    page_text) {

  if (steps == null) {
    throw "Steps null wtf";
  }

  const categorizeModel = CATEGORIZE_PROMPT.preferredModel;//overrideModel || CATEGORIZE_PROMPT.preferredModel;
  const maybeCategorizeRow =
      await db.getCachedPageCategory(url, categorizeModel, CATEGORIZE_PROMPT.version);
  let category = maybeCategorizeRow && maybeCategorizeRow.response;
  if (category) {
    console.log("Using cached category.");
    gptCacheCounter.count++;
  } else {
    logs(steps)({ "": "Asking GPT to describe page text at " + url, "pageTextUrl": url });
    const slicedQuery =
        modelToLlmRequester[categorizeModel].slice(
          CATEGORIZE_PROMPT.text + "\n\nBEGINPAGE\n\n" + page_text,
          CATEGORIZE_PROMPT.maxTokens);
    category =
        await modelToLlmRequester[categorizeModel].request(
            slicedQuery, CATEGORIZE_PROMPT.maxTokens, throttlerPriority, maybeIdForLogging);
    if (!category || !category.replaceAll) {
      console.log("Null category?", category)
      process.exit(1)
    }
    const categoryCleaned = category.replaceAll(/['"\s\.]/g, '').toLowerCase();
    if (categoryCleaned == "single") {
      // good, continue
    } else if (categoryCleaned == "multiple") {
      // good, continue
    } else if (categoryCleaned == "nothing") {
      // good, continue
    } else {
      await db.cachePageCategory({
        url,
        model: categorizeModel,
        prompt_version: CATEGORIZE_PROMPT.version,
        status: 'error',
        response: category,
      });
      if (category.length > 100) {
        logs(steps)({"": "Bad GPT response:", details: category});
        return {status: "error", description: null, error: {"": "Bad GPT response:", details: category}};
      } else {
        logs(steps)("Bad GPT response:", category);
        return {status: "error", description: null, error: "Bad GPT response:" + category};
      }
    }

    category = categoryCleaned;

    await db.cachePageCategory({
      url,
      model: categorizeModel,
      prompt_version: CATEGORIZE_PROMPT.version,
      status: 'success',
      response: category,
    });
    logs(steps)("Category response:", category);
  }

  if (category != "single") {
    logs(steps)("LLM said not single event:", category, "so skipping.");
    return {status: "rejected", description: null, error: "Not single event: " + category};
  }

  const summarizeModel = SUMMARIZE_PROMPT.preferredModel;//overrideModel || SUMMARIZE_PROMPT.preferredModel;
  const maybeSummaryRow = await db.getCachedPageSummary(url, summarizeModel, SUMMARIZE_PROMPT.version);
  let description = maybeSummaryRow && maybeSummaryRow.response;
  if (description) {
    console.log("Using cached summary.");
    gptCacheCounter.count++;
  } else {
    logs(steps)({ "": "Asking GPT to describe page text at " + url, "pageTextUrl": url });
    const slicedQuery =
        modelToLlmRequester[summarizeModel].slice(
            SUMMARIZE_PROMPT.text + "\n\nBEGINPAGE\n\n" + page_text,
            SUMMARIZE_PROMPT.maxTokens);
    description =
        await modelToLlmRequester[summarizeModel].request(
            slicedQuery, SUMMARIZE_PROMPT.maxTokens, throttlerPriority, maybeIdForLogging);
    // console.log("question:", SUMMARIZE_PROMPT + "\n------\n" + page_text);
    // console.log("answer:", description);
    await db.cachePageSummary({
      url,
      model: summarizeModel,
      prompt_version: SUMMARIZE_PROMPT.version,
      status: 'success',
      response: description,
    });
    logs(steps)({ "": "GPT response:", "details": description });
  }

  // console.log("GPT:");
  // console.log(description);

  if (description.trim().toLowerCase().startsWith("nothing")) {
    const error = {
      "": "Not an event, skipping.",
      description
    };
    logs(steps)(error);
    return {status: "rejected", description, error};
  }
  if (description.trim().toLowerCase().startsWith("multiple")) {
    const error = {
      "": "Multiple events, skipping.",
      description
    };
    logs(steps)(error);
    return {status: "rejected", description, error};
  }
  if (description.trim().length < 20) {
    const error = {
      "": "Too short, probably bad, skipping.",
      description
    };
    logs(steps)(error);
    return {status: "error", description, error};
  }

  return {status: "success", description, error: null};
}


// Returns a map of question to answer.
// Might throw.
export async function askQuestionsForPageOuter(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    retryErrors,
    steps,
    overrideModel,
    maybeIdForLogging,
    url,
    description,
    questions) {
  const modelToQuestions = {};
  for (const question of questions) {
    if (!question.preferredModel) {
      throw "wat no question.preferredModel";
    }
    const questionModel = overrideModel || question.preferredModel;
    modelToQuestions[questionModel] = modelToQuestions[questionModel] || [];
    modelToQuestions[questionModel].push(question);
  }

  let mergedQuestionToAnswer = {};
  for (const model in modelToQuestions) {
    console.log("modelToQuestions has", model);
    const questions = modelToQuestions[model];

    if (modelToLlmRequester[overrideModel || model].smart) {
      const questionToAnswerForThisModel =
          await askMultipleQuestionsForPageInner(
              db,
              gptCacheCounter,
              modelToLlmRequester,
              throttlerPriority,
              retryErrors,
              steps,
              model,
              maybeIdForLogging,
              url,
              description,
              questions);
      mergedQuestionToAnswer = {...mergedQuestionToAnswer, ...questionToAnswerForThisModel};
    } else {
      for (const question of questions) {
        const answer =
            await askSingleQuestionForPageInner(
                db,
                gptCacheCounter,
                modelToLlmRequester,
                throttlerPriority,
                retryErrors,
                steps,
                model,
                maybeIdForLogging,
                url,
                description,
                question);
        mergedQuestionToAnswer[question.text] = answer;
      }
    }
  }
  return mergedQuestionToAnswer;
}

// Returns a map of question to answer.
// Might throw.
export async function askMultipleQuestionsForPageInner(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    retryErrors,
    steps,
    model,
    maybeIdForLogging,
    url,
    description,
    questions) {
  if (steps == null) {
    throw "Steps null wtf";
  }

  console.log("questions:", questions);
  const questionToMaybeCachedAnswer = {};
  for (const {text: question, maxTokens} of questions) {
    const questionRow =
        await db.getAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT.version);
    if (questionRow) {
      console.log(("Resuming question row " + questionRow.url + ": " + questionRow.question).slice(0, 80));
    } else {
      console.log(("Creating analysis question row:" + question).slice(0, 80));
      await db.createAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT.version, maxTokens);
    }
    if (questionRow && questionRow.answer) {
      if (questionRow.status == 'error' && retryErrors) {
        // Don't add it to the map, let's retry it
      } else {
        questionToMaybeCachedAnswer[question] = questionRow.answer;
      }
    }
  }

  let analyzeQuestion =
    "below the dashes is a description of an event. please answer the following questions, numbered, each on their own line.\n";
  let nextGptQuestionNumber = 1;

  const questionToGptQuestionNumber = {};
  const gptQuestionNumberToQuestion = {};

  for (const question of questions) {
    if (questionToMaybeCachedAnswer[question.text] == null) {
      const gptQuestionNumber = nextGptQuestionNumber++;
      analyzeQuestion += gptQuestionNumber + ". " + question.text + "\n";
      questionToGptQuestionNumber[question.text] = gptQuestionNumber;
      gptQuestionNumberToQuestion[gptQuestionNumber] = question;
    }
  }

  const questionToGptAnswer = {};

  let analysisResponse = "(didn't ask)";
  if (nextGptQuestionNumber == 1) {
    // Then don't ask, itll just get confused.
    logs(steps)("No questions, skipping...");
    gptCacheCounter.count++;
  } else {
    const slicedQuery =
        modelToLlmRequester[model].slice(
            analyzeQuestion + "\n------\n" + description,
            null);
    logs(steps)({ "": "Asking GPT to analyze...", "details": slicedQuery });
    analysisResponse =
      await modelToLlmRequester[model].request(
          slicedQuery, null, throttlerPriority, maybeIdForLogging);
    logs(steps)({ "": "Analysis response:", "details": analysisResponse });
    // console.log("GPT:")
    // console.log(analysisResponse);
    // steps.push(analysisResponse);

    for (const lineUntrimmed of analysisResponse.split("\n")) {
      // console.log("bork a", submissionId, url);
      const line = lineUntrimmed.trim().replace(/"/g, "");
      const answerParts = /\s*(\d*)?\s*[:\.]?\s*(.*)/i.exec(line);
      if (nextGptQuestionNumber == 2) { // Only one question.
        // console.log("bork b", submissionId, url);
        // Since only one question, we're a little more lax, we're fine if the number isn't there.
        if (!answerParts || !answerParts[2]) {
          const error = {
            "": "Got invalid line: " + line,
            analyzeQuestion,
            analysisResponse,
            line,
            answerParts
          };
          logs(steps)(error);
          await db.finishAnalysisQuestion(
            url, question, model, SUMMARIZE_PROMPT.version, 'error', null, null, error);
          continue;
        }
        const answerRaw = answerParts[2];
        const question = questions[0];
        // console.log("bork c", submissionId, url);
        const answerCleaned = (question.cleaner)(answerRaw);
        questionToGptAnswer[question.text] = answerCleaned;
        await db.finishAnalysisQuestion(
            url, question.text, model, SUMMARIZE_PROMPT.version, 'success', answerRaw, answerCleaned, null);
        break;
      } else {
        // console.log("bork e", submissionId, url);
        if (!answerParts || !answerParts[1] || !answerParts[2]) {
          logs(steps)("Got invalid line:", line);
          continue;
        }
        const numberStr = answerParts[1].replace(/\D/g, '');
        const number = numberStr - 0;
        // console.log("bork f", submissionId, url);
        if (number != numberStr) {
          const error = {
            "": "Got line with invalid number: " + numberStr,
            analyzeQuestion,
            analysisResponse,
            line,
            answerParts,
            numQuestions: Object.keys(questionToGptAnswer).length
          };
          logs(steps)(error);
          await db.finishAnalysisQuestion(
            url, question, model, SUMMARIZE_PROMPT.version, 'error', null, null, error);
          continue;
        }
        // console.log("bork g", submissionId, url);
        const question = gptQuestionNumberToQuestion[number];
        if (question == null) {
          const error = {
            "": "Got line with unknown number: " + numberStr,
            analyzeQuestion,
            analysisResponse,
            line,
            answerParts,
            numQuestions: Object.keys(questionToGptAnswer).length
          };
          await db.finishAnalysisQuestion(
            url, question.text, model, SUMMARIZE_PROMPT.version, 'error', null, null, error);
          continue;
        }
        // console.log("bork h", submissionId, url);
        const answerRaw = answerParts[2];
        logs(steps)("Got answer for question", question.text, "Raw answer:", answerRaw);
        const answerCleaned = (question.cleaner)(answerRaw);

        questionToGptAnswer[question.text] = answerCleaned;
        // console.log("bork i", submissionId, url);
        await db.finishAnalysisQuestion(url, question.text, model, SUMMARIZE_PROMPT.version, 'success', answerRaw, answerCleaned, null);
      }
        // console.log("bork j", submissionId, url);
    }
        // console.log("bork k", submissionId, url);
  }
        // console.log("bork l", submissionId, url);

  const questionToAnswer = {};
  for (const {text: question, maxTokens} of questions) {
    const questionRow =
        await db.getAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT.version);
    if (questionRow == null) {
      const error = {
        "": "Question/answer not found!",
        analyzeQuestion,
        analysisResponse,
        question,
        nextGptQuestionNumber,
        questionToMaybeCachedAnswer,
        questionToGptAnswer
      };
      await db.finishAnalysisQuestion(
          url, question, model, SUMMARIZE_PROMPT.version, 'error', null, null, error);
      throw logs(false, steps)(error);
    }
    if (questionRow.status == 'success') {
      // continue
    } else if (questionRow.status == 'created') {
      console.log("Question is status created, returning.");
      return null;
    } else if (questionRow.status == 'error') {
      const error = {
        "": "Question row had error:",
        analyzeQuestion,
        analysisResponse,
        questionRow
      };
      logs(steps)(error);
      throw error;
    } else {
      throw logs(steps)("Wat response from analyze question:", questionRow.status);
    }
    const oracleAnswerRow =
        await db.getAnalysisQuestion(url, question, "verdagon", SUMMARIZE_PROMPT.version);
    if (oracleAnswerRow) {
      const oracleAnswer = oracleAnswerRow && oracleAnswerRow.answer;
      questionToAnswer[question] = oracleAnswer;
      logs(steps)("Oracle overrode answer, to \"", oracleAnswer, "\" for question: ", question);
    } else {
      questionToAnswer[question] = questionRow.answer;
      logs(steps)("Answered \"", questionRow.answer, "\" for question: ", question, (questionToMaybeCachedAnswer[question] ? " (cached)" : ""));
    }
  }

  return questionToAnswer;
}

// Returns the answer, or null.
// Might throw.
export async function askSingleQuestionForPageInner(
    db,
    gptCacheCounter,
    modelToLlmRequester,
    throttlerPriority,
    retryErrors,
    steps,
    model,
    maybeIdForLogging,
    url,
    description,
    question) {
  if (steps == null) {
    throw "Steps null wtf";
  }

  const questionText = question.text;
  const maxTokens = question.maxTokens;

  const questionRow =
      await db.getAnalysisQuestion(url, questionText, model, SUMMARIZE_PROMPT.version);
  if (questionRow) {
    console.log(("Resuming question row " + questionRow.url + ": " + questionRow.question).slice(0, 80));
  } else {
    console.log(("Creating analysis question row:" + questionText).slice(0, 80));
    await db.createAnalysisQuestion(url, questionText, model, SUMMARIZE_PROMPT.version, maxTokens);
  }
  if (questionRow && questionRow.answer) {
    if (questionRow.status == 'error' && retryErrors) {
      // Don't add it to the map, let's retry it
    } else {
      return questionRow.answer;
    }
  }

  let analyzeQuestion =
    "below the dashes is a description of an event. " + questionText + "\n";

  const slicedQuery =
      modelToLlmRequester[model].slice(
          analyzeQuestion + "\n------\n" + description,
          question.maxTokens);
  const answerRaw =
      await modelToLlmRequester[model].request(
          slicedQuery, question.maxTokens, throttlerPriority, maybeIdForLogging);

  if (!answerRaw || !answerRaw.trim()) {
    const error = {
      "": "Got invalid line: " + answerRaw,
      analyzeQuestion,
      answerRaw
    };
    logs(steps)(error);
    await db.finishAnalysisQuestion(
        url, questionText, model, SUMMARIZE_PROMPT.version, 'error', null, null, error);
    const outerError = {
      "": "Question row had error:",
      model,
      analyzeQuestion,
      answerRaw
    };
    logs(steps)(outerError);
    throw outerError;
  }
  logs(steps)("Got answer for question", questionText, "Raw answer:", answerRaw);

  const answerCleaned = (question.cleaner)(answerRaw);
  await db.finishAnalysisQuestion(
      url, questionText, model, SUMMARIZE_PROMPT.version, 'success', answerRaw, answerCleaned, null);

  const oracleAnswerRow =
      await db.getAnalysisQuestion(url, questionText, "verdagon", SUMMARIZE_PROMPT.version);
  if (oracleAnswerRow) {
    const oracleAnswer = oracleAnswerRow && oracleAnswerRow.answer;
    steps.push(["Oracle overrode answer, to \"", oracleAnswer, "\" for question: ", questionText]);
    return oracleAnswer;
  } else {
    steps.push(["Answered \"", answerCleaned, "\" for question: ", questionText]);
    return answerCleaned;
  }
}
