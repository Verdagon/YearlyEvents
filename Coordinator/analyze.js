import { Configuration, OpenAIApi } from "openai";
// import { dbCachedZ, getFromDb } from '../db.js'
import { delay } from "../Common/parallel.js";
import { logs, normalizeName, VException } from "../Common/utils.js";
import { askTruncated } from "../Common/gptUtils.js";
import { getPageText } from "./getpagetext.js";
import fs from "fs/promises";

// These key numbers are stored in the database.
// If we want to change a question, best use a new number.

const SUMMARIZE_PROMPT_VERSION = 1;
const SUMMARIZE_PROMPT =
		"Below the dashes is a webpage. is it describing a yearly event, yearly competition, yearly gathering, yearly festival, yearly celebration? if none of the above, please only say \"nothing\" and nothing else. if there are multiple, only say \"multiple\" and nothing else. if it is one of those things however, please give me a paragraph of max 20 sentences describing it, including the event's name, city, state, whether it happens every year, what month it's on, the first date of the event, most recent date of the event, future date of the event, and the year it ended.";

const YEAR_QUESTION = "does the event happen every year? say \"yes\", \"no\", or if not known then \"unknown\".";
const NAME_QUESTION = "what's the event's name?";
const CITY_QUESTION = "what city is the event held in? say \"unknown\" if not known.";
const STATE_QUESTION = "what state is the event held in? say \"unknown\" if not known.";
const FIRST_DATE_QUESTION = "when did the event first happen? say \"unknown\" if not known.";
const LAST_DATE_QUESTION = "when was the last event? say \"unknown\" if not known.";
const NEXT_DATE_QUESTION = "when will the event happen again? say \"unknown\" if not known.";
const MONTH_QUESTION = "what month does the event happen on? say \"unknown\" if not known.";
const SUMMARY_QUESTION = "what's a one-sentence description of the event?";
const UNUSUAL_QUESTION = "is there anything particularly unique or unusual about the event?";
const MULTIPLE_EVENTS_QUESTION = "does the description describe multiple different events?";
  // Maybe change different to unrelated?

function startsWithUnknown(line) {
	return /unknown/i.test(line);
}
function startsWithYes(line) {
	return /yes/i.test(line);
}
function startsWithNo(line) {
	return /no/i.test(line);
}
function getStartBoolOrNull(line) {
	if (startsWithUnknown(line)) {
		return null;
	} else if (startsWithYes(line)) {
		return true;
	} else if (startsWithNo(line)) {
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

export async function analyzePageOuter(
    openai,
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    chromeFetcher,
    chromeCacheCounter,
    gptThrottler,
    throttlerPriority,
    gptCacheCounter,
    model,
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

  // We should only have all three or none
  if (!!matchName != !!matchCity || !!matchName != !!matchState) {
    throw logs(broadSteps)("Must have all or none of matchName, matchCity, matchState");
  }

  try {
    await db.transaction(async (trx) => {
      const maybePageAnalysisRow = await trx.getPageAnalysis(url, model);
      if (maybePageAnalysisRow) {
        pageAnalysisStatus = maybePageAnalysisRow.status;
        pageSteps = maybePageAnalysisRow.steps || [];
      }
      if (pageAnalysisStatus == null) {
        logs(pageSteps, broadSteps)("Starting analysis for page:", url);
        await trx.startPageAnalysis(url, model);
        pageAnalysisStatus = 'created';
      } else if (pageAnalysisStatus == 'created') {
        console.log("Resuming existing page analysis row for:", url);
      } else {
        console.log("Page analysis already finished for url:", url, "but proceeding in case match needed.");
      }
    });

    // Sanity check
    if (!await db.getPageAnalysis(url, model)) {
      throw logs(pageSteps)("No analysis to use?!");
    }

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, maybeIdForLogging, pageSteps, event_i, search_result_i, url);
    pageText = pageText_;
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
            gptThrottler,
            throttlerPriority,
            pageSteps,
            openai,
            model,
            maybeIdForLogging,
            url,
            pageText);
    if (describeStatus == 'error') {
      logs(pageSteps, broadSteps)("Describe had errors, marking analysis errors.");
      await db.finishPageAnalysis(url, model, 'errors', pageSteps, null);
      return;
    } else if (describeStatus == 'success') {
      // Proceed
    } else {
      throw logs(pageSteps, broadSteps)("Bad status wtf:", describeStatus, description, describeError);
    }

    const [analysis, analyzeInnerStatus] =
        await analyzePageInner(
            db,
            gptCacheCounter,
            gptThrottler,
            throttlerPriority,
            pageSteps,
            openai,
            model,
            url,
            pageText,
            matchName ? makeMatchQuestions(matchName, matchCity, matchState) : []);

    if (analyzeInnerStatus == 'created') {
      console.log("Inner analyze status created, marking page analysis created.");
      await db.finishPageAnalysis(url, model, 'created', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'errors') {
      logs(pageSteps, broadSteps)("Inner analyze had errors, marking analysis errors.");
      await db.finishPageAnalysis(url, model, 'errors', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'rejected') {
      logs(pageSteps, broadSteps)("Inner analyze rejected, wasn't an event, rejecting analyses.");
      await db.finishPageAnalysis(url, model, 'errors', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'success') {
      console.log("Inner analyze status created, marking page analysis success.");
      await db.finishPageAnalysis(url, model, 'success', pageSteps, analysis);
    } else {
      throw logs(broadSteps)("Wat analyze response:", analysis, analyzeInnerStatus)
    }

    // sanity check
    if (!await db.getPageAnalysis(url, model)) {
      throw logs(pageSteps)("No analysis to use?!");
    }

  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(pageSteps, broadSteps)(error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishPageAnalysis(url, model, 'errors', pageSteps, analysis);
  }
}

export async function analyzeMatchOuter(
    openai,
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    chromeFetcher,
    chromeCacheCounter,
    gptThrottler,
    throttlerPriority,
    gptCacheCounter,
    submissionId,
    model,
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

  // We should only have all three or none
  if (!!matchName != !!matchCity || !!matchName != !!matchState) {
    throw logs(broadSteps)("Must have all or none of matchName, matchCity, matchState");
  }

  try {
    await db.transaction(async (trx) => {
      const matchRow = await trx.getMatchAnalysis(submissionId, url, model);
      if (matchRow) {
        matchStatus = matchRow.status;
        matchSteps = matchRow.steps || [];
      }
      if (matchStatus == null) {
        logs(matchSteps, broadSteps)("Starting analysis for page:", url);
        await trx.startMatchAnalysis(submissionId, url, model);
        matchStatus = 'created';
      } else if (matchStatus == 'created') {
        console.log("Resuming existing page analysis row for:", url);
      } else {
        console.log("Page analysis already finished for url:", url, "but proceeding in case match needed.");
      }
    });

    // Sanity check
    if (!await db.getMatchAnalysis(submissionId, url, model)) {
      throw logs(matchSteps)("No analysis to use?!");
    }

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, submissionId, matchSteps, event_i, search_result_i, url);
    pageText = pageText_;
    pageTextError = pageTextError_;

    if (pageTextError) {
      throw logs(matchSteps, broadSteps)("Bad pdf-to-text. Error:", pageTextError);
    }
    if (!pageText) {
      // This actually shouldnt happen, there's a check in getPageText.
      throw logs(matchSteps, broadSteps)("Seemingly successful pdf-to-text, but no page text and no error!");
    }

    const matchness =
        await analyzeMatchInner(
            db,
            gptCacheCounter,
            gptThrottler,
            throttlerPriority,
            matchSteps,
            openai,
            model,
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

    await db.finishMatchAnalysis(submissionId, url, model, 'success', matchSteps, matchness);

    // sanity check
    if (!await db.getMatchAnalysis(submissionId, url, model)) {
      throw logs(matchSteps)("No match analysis to use?!");
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(matchSteps, broadSteps)(error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishMatchAnalysis(submissionId, url, model, 'errors', matchSteps, matchness);
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
    gptThrottler,
    throttlerPriority,
    steps,
    openai,
    model,
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
		NEXT_DATE_QUESTION,
		MONTH_QUESTION,
		SUMMARY_QUESTION
	];
  if (extraStowawayQuestions) {
    questions = questions.concat(extraStowawayQuestions);
  }

  const questionToAnswer =
      await askQuestionsForPage(
          db,
          gptCacheCounter,
          gptThrottler,
          throttlerPriority,
          steps,
          openai,
          model,
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

  logs(steps)("Considering answers...");

	const multipleEventsAnswer = questionToAnswer[MULTIPLE_EVENTS_QUESTION];
	if (getStartBoolOrNull(multipleEventsAnswer) !== false) {
    logs(steps)("Multiple events, rejecting.");
		return [null, null, "rejected"];
	}

	const cityAnswer = questionToAnswer[CITY_QUESTION];
	analysis.city = isKnownTrueOrNull(cityAnswer) && cityAnswer;
  if (!analysis.city) {
    logs(steps)("Couldn't find city from page, rejecting.");
    return [null, analysis, "rejected"];
  }

	const stateAnswer = questionToAnswer[STATE_QUESTION];
	analysis.state = isKnownTrueOrNull(stateAnswer) && stateAnswer;
  if (!analysis.state) {
    logs(steps)("Couldn't find state from page, rejecting.");
    return [null, analysis, "rejected"];
  }

  const nameAnswer = questionToAnswer[NAME_QUESTION];
  analysis.name =
      isKnownTrueOrNull(nameAnswer) &&
      normalizeName(nameAnswer, analysis.city, analysis.state);
  if (!analysis.name) {
    logs(steps)("Couldn't find name from page, rejecting.");
    return [null, analysis, "rejected"];
  }

  const summaryAnswer = questionToAnswer[SUMMARY_QUESTION];
  analysis.summary = isKnownTrueOrNull(summaryAnswer) && summaryAnswer;
  if (!analysis.summary || analysis.summary.length < 20) {
    logs(steps)("Error, summary missing or too short:", summaryAnswer);
    return [null, analysis, "errors"];
  }

  const yearAnswer = questionToAnswer[YEAR_QUESTION];
  analysis.yearly = getStartBoolOrNull(yearAnswer);

	const firstDateAnswer = questionToAnswer[FIRST_DATE_QUESTION];
	analysis.firstDate = isKnownTrueOrNull(firstDateAnswer) && firstDateAnswer;

	const lastDateAnswer = questionToAnswer[LAST_DATE_QUESTION];
	analysis.lastDate = isKnownTrueOrNull(lastDateAnswer) && lastDateAnswer;

	const nextDateAnswer = questionToAnswer[NEXT_DATE_QUESTION];
	analysis.nextDate = isKnownTrueOrNull(nextDateAnswer) && nextDateAnswer;

	const monthAnswer = questionToAnswer[MONTH_QUESTION];
	analysis.month = isKnownTrueOrNull(monthAnswer) && getMonthOrNull(monthAnswer);

  logs(steps)("Analysis complete:", analysis);
	return [analysis, "success"];
}

function makeMatchQuestions(matchName, matchCity, matchState) {
  return [
      "is it primarily referring to or describing or talking about the " + matchName + " event in " + matchCity + ", " + matchState + "? start your answer with \"yes\" or \"no\", if no then say why.",
      "is it primarily referring to or describing or talking about the " + matchName + " event in " + matchState + "? start your answer with \"yes\" or \"no\", if no then say why.",
      "is it primarily referring to or describing or talking about the " + matchName + " event? start your answer with \"yes\" or \"no\", if no then say why."
  ];
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
export async function analyzeMatchInner(
    db,
    gptCacheCounter,
    gptThrottler,
    throttlerPriority,
    steps,
    openai,
    model,
    url,
    description,
    matchName,
    matchCity,
    matchState) {
  if (steps == null) {
    throw "Steps null wtf";
  }

  const questions = makeMatchQuestions(matchName, matchCity, matchState);
  const [matchesCityQuestion, matchesStateQuestion, matchesAnywhereQuestion] = questions;

  const questionToAnswer =
      await askQuestionsForPage(
          db,
          gptCacheCounter,
          gptThrottler,
          throttlerPriority,
          steps,
          openai,
          model,
          url,
          description,
          questions);

  logs(steps)("Considering answers...");

  let matchness = 1;
  const matchesAnywhereAnswer = questionToAnswer[matchesAnywhereQuestion];
  const matchesAnywhere = getStartBoolOrNull(matchesAnywhereAnswer);
  if (matchesAnywhere) {
    matchness = 2;
  }
  const matchesStateAnswer = questionToAnswer[matchesStateQuestion];
  const matchesState = getStartBoolOrNull(matchesStateAnswer);
  if (matchesState) {
    matchness = 3;
  }
  const matchesCityAnswer = questionToAnswer[matchesCityQuestion];
  const matchesCity = getStartBoolOrNull(matchesCityAnswer);
  if (matchesCity) {
    matchness = 4;
  }

  return matchness;
}

// Returns a {status, description, error}
export async function describePage(
    db,
    gptCacheCounter,
    gptThrottler,
    throttlerPriority,
    steps,
    openai,
    model,
    maybeIdForLogging,
    url,
    page_text) {

  if (steps == null) {
    throw "Steps null wtf";
  }

  const maybeRow = await db.getCachedSummary(url, model, SUMMARIZE_PROMPT_VERSION);
  let description = maybeRow && maybeRow.response;

  if (description) {
    console.log("Using cached summary.");
  } else {
    logs(steps)({ "": "Asking GPT to describe page text at " + url, "pageTextUrl": url });
    description =
        await askTruncated(
            gptThrottler, throttlerPriority, openai, maybeIdForLogging,
            SUMMARIZE_PROMPT + "\n------\n" + page_text);
    await db.cachePageSummary({
      url,
      model,
      prompt_version: SUMMARIZE_PROMPT_VERSION,
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
    return {status: "error", description, error};
  }
  if (description.trim().toLowerCase().startsWith("multiple")) {
    const error = {
      "": "Multiple events, skipping.",
      description
    };
    logs(steps)(error);
    return {status: "error", description, error};
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
export async function askQuestionsForPage(
    db,
    gptCacheCounter,
    gptThrottler,
    throttlerPriority,
    steps,
    openai,
    model,
    url,
    description,
    questions) {
  if (steps == null) {
    throw "Steps null wtf";
  }

  const questionToMaybeCachedAnswer = {};
  for (const question of questions) {
    const questionRow =
        await db.getAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT_VERSION);
    if (questionRow) {
      console.log(("Resuming question row " + questionRow.url + ": " + questionRow.question).slice(0, 80));
    } else {
      console.log(("Creating analysis question row:" + question).slice(0, 80));
      await db.createAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT_VERSION);
    }
    if (questionRow && questionRow.answer) {
      questionToMaybeCachedAnswer[question] = questionRow.answer;
    }
  }

  let analyzeQuestion =
    "below the dashes is a description of an event. please answer the following questions, numbered, each on their own line.\n";
  let nextGptQuestionNumber = 1;

  const questionToGptQuestionNumber = {};
  const gptQuestionNumberToQuestion = {};

  for (const question of questions) {
    if (questionToMaybeCachedAnswer[question] == null) {
      const gptQuestionNumber = nextGptQuestionNumber++;
      analyzeQuestion += gptQuestionNumber + ". " + question + "\n";
      questionToGptQuestionNumber[question] = gptQuestionNumber;
      gptQuestionNumberToQuestion[gptQuestionNumber] = question;
    }
  }

  const questionToGptAnswer = {};

  let analysisResponse = "(didn't ask)";
  if (nextGptQuestionNumber == 1) {
    // Then don't ask, itll just get confused.
    logs(steps)("No questions, skipping...");
  } else {
    logs(steps)("Asking GPT to analyze...");
    // console.log("bork 0", submissionId, url);
    analysisResponse =
      await askTruncated(
          gptThrottler, throttlerPriority, openai, maybeIdForLogging,
          analyzeQuestion + "\n------\n" + description);
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
            url, question, model, SUMMARIZE_PROMPT_VERSION, 'error', null, error);
          continue;
        }
        const answer = answerParts[2];
        for (const question in questionToGptQuestionNumber) {
          // console.log("bork c", submissionId, url);
          questionToGptAnswer[question] = answer;
          await db.finishAnalysisQuestion(
              url, question, model, SUMMARIZE_PROMPT_VERSION, 'success', answer, null);
          break;
        }
        throw logs(steps)("Couldn't answer only question?");
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
            url, question, model, SUMMARIZE_PROMPT_VERSION, 'error', null, error);
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
            url, question, model, SUMMARIZE_PROMPT_VERSION, 'error', null, error);
          continue;
        }
        // console.log("bork h", submissionId, url);
        const answer = answerParts[2];

        questionToGptAnswer[question] = answer;
        // console.log("bork i", submissionId, url);
        await db.finishAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT_VERSION, 'success', answer, null);
      }
        // console.log("bork j", submissionId, url);
    }
        // console.log("bork k", submissionId, url);
  }
        // console.log("bork l", submissionId, url);

  const questionToAnswer = {};
  for (const question of questions) {
    const questionRow =
        await db.getAnalysisQuestion(url, question, model, SUMMARIZE_PROMPT_VERSION);
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
          url, question, model, SUMMARIZE_PROMPT_VERSION, 'error', null, error);
      throw logs(false, steps)(error);
    }
    if (questionRow.status == 'success') {
      // continue
    } else if (questionRow.status == 'created') {
      console.log("Question is status created, returning.");
      return [0, null, "created"];
    } else if (questionRow.status == 'error') {
      const error = {
        "": "Question row had error:",
        analyzeQuestion,
        analysisResponse,
        questionRow
      };
      logs(steps)(error);
      return [null, null, "errors"];
    } else {
      throw logs(steps)("Wat response from analyze question:", questionRow.status);
    }
    questionToAnswer[question] = questionRow.answer;
    steps.push(["Answered \"", questionRow.answer, "\" to: ", question, (questionToMaybeCachedAnswer[question] ? " (cached)" : "")]);
  }

  return questionToAnswer;
}
