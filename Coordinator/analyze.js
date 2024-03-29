import { Configuration, OpenAIApi } from "openai";
// import { dbCachedZ, getFromDb } from '../db.js'
import { delay } from "../Common/parallel.js";
import { logs, normalizeName } from "../Common/utils.js";
import { askTruncated } from "../Common/gptUtils.js";
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
export async function analyzePage(
    db,
    gptCacheCounter,
    gptThrottler,
    throttlerPriority,
    steps,
    openai,
    submissionId,
    model,
    url,
    page_text,
    matchName,
    matchCity,
    matchState) {

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
		    await askTruncated(gptThrottler, throttlerPriority, openai, submissionId, SUMMARIZE_PROMPT + "\n------\n" + page_text);
		await db.cachePageSummary({url, model, response: description, prompt_version: SUMMARIZE_PROMPT_VERSION});
    logs(steps)({ "": "GPT response:", "details": description });
	}

	// console.log("GPT:");
	// console.log(description);

	if (description.trim().toLowerCase().startsWith("nothing")) {
		logs(steps)("Not an event, skipping.");
		return [0, null, "success"];
	}
	if (description.trim().toLowerCase().startsWith("multiple")) {
		logs(steps)("Multiple events, skipping.");
		return [5, null, "success"];
	}
	if (description.trim().length < 20) {
		logs(steps)("Too short, probably bad, skipping.");
		return [0, null, "success"];
	}


	const matchesCityQuestion =
      matchName && matchCity && matchState && ("is it primarily referring to or describing or talking about the " + matchName + " event in " + matchCity + ", " + matchState + "? start your answer with \"yes\" or \"no\", if no then say why.");
	const matchesStateQuestion =
      matchState == null ? null : "is it primarily referring to or describing or talking about the " + matchName + " event in " + matchState + "? start your answer with \"yes\" or \"no\", if no then say why.";
	const matchesAnywhereQuestion =
      matchCity == null ? null : "is it primarily referring to or describing or talking about the " + matchName + " event? start your answer with \"yes\" or \"no\", if no then say why.";

	const questions = [
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
  if (matchesCityQuestion) {
    questions.push(matchesCityQuestion);
  }
  if (matchesStateQuestion) {
    questions.push(matchesStateQuestion);
  }
  if (matchesAnywhereQuestion) {
    questions.push(matchesAnywhereQuestion);
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
			await askTruncated(gptThrottler, throttlerPriority, openai, submissionId, analyzeQuestion + "\n------\n" + description);
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
      return [0, null, "errors"];
    } else {
      throw logs(steps)("Wat response from analyze question:", questionRow.status);
    }
		questionToAnswer[question] = questionRow.answer;
		steps.push(["Answered \"", questionRow.answer, "\" to: ", question, (questionToMaybeCachedAnswer[question] ? " (cached)" : "")]);
	}

	const matches = {
		city: null,
		state: null,
		anywhere: null
	}
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
		matches: matches, // We could remove this to make the analysis query agnostic
		description: description
	};

  logs(steps)("Considering answers...");

	const multipleEventsAnswer = questionToAnswer[MULTIPLE_EVENTS_QUESTION];
	if (getStartBoolOrNull(multipleEventsAnswer) !== false) {
    logs(steps)("Multiple events, rejecting.");
		return [5, null, "rejected"];
	}

	const cityAnswer = questionToAnswer[CITY_QUESTION];
	analysis.city = isKnownTrueOrNull(cityAnswer) && cityAnswer;
  if (!analysis.city) {
    logs(steps)("Couldn't find city from page, rejecting.");
    return [0, analysis, "rejected"];
  }

	const stateAnswer = questionToAnswer[STATE_QUESTION];
	analysis.state = isKnownTrueOrNull(stateAnswer) && stateAnswer;
  if (!analysis.state) {
    logs(steps)("Couldn't find state from page, rejecting.");
    return [0, analysis, "rejected"];
  }

  const nameAnswer = questionToAnswer[NAME_QUESTION];
  analysis.name =
      isKnownTrueOrNull(nameAnswer) &&
      normalizeName(nameAnswer, analysis.city, analysis.state);
  if (!analysis.name) {
    logs(steps)("Couldn't find name from page, rejecting.");
    return [0, analysis, "rejected"];
  }

  const summaryAnswer = questionToAnswer[SUMMARY_QUESTION];
  analysis.summary = isKnownTrueOrNull(summaryAnswer) && summaryAnswer;
  if (!analysis.summary || analysis.summary.length < 20) {
    logs(steps)("Error, summary missing or too short:", summaryAnswer);
    return [0, analysis, "errors"];
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

  let matchness = 1;
  if (matchesAnywhereQuestion) {
    const matchesAnywhereAnswer = questionToAnswer[matchesAnywhereQuestion];
    const matchesAnywhere = getStartBoolOrNull(matchesAnywhereAnswer);
    if (matchesAnywhere) {
      matchness = 2;
    }
  }
  if (matchesStateQuestion) {
    const matchesStateAnswer = questionToAnswer[matchesStateQuestion];
    const matchesState = getStartBoolOrNull(matchesStateAnswer);
    if (matchesState) {
      matchness = 3;
    }
  }
  if (matchesCityQuestion) {
  	const matchesCityAnswer = questionToAnswer[matchesCityQuestion];
  	const matchesCity = getStartBoolOrNull(matchesCityAnswer);
    if (matchesCity) {
      matchness = 4;
    }
  }

  logs(steps)("Analysis complete, matchness", matchness);
	return [matchness, analysis, "success"];
}
