import { Configuration, OpenAIApi } from "openai";

import fs from "fs/promises";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


function unprependi(str, prefix, minLength) {
	if (str.toLowerCase().startsWith(prefix.toLowerCase())) {
		const result = str.substring(prefix.length);
		if (minLength != null) {
			if (result.length >= minLength) {
				return result;
			}
		} else {
			return result;
		}
	}
	return str;
}

function unprependiall(originalStr, prefixes, minLength) {
	for (let prefix of prefixes) {
		const newStr = unprependi(originalStr, prefix, minLength);
		if (newStr.length != originalStr.length) {
			return unprependiall(newStr, prefixes, minLength);
		}
	}
	return originalStr;
}

function normalizeName(name, city, state) {
	return unprependiall(
			name,
			[
				" ",
				".",
				"-",
				"international ",
				"national ",
				"annual ",
				"yearly ",
				"world ",
				"state ",
				"us ",
				"the ",
				city + " ",
				state + " ",
				city + "'s",
				state + "'s"
			],
			9);
}

const askTruncated = async (throttler, openai, query, numAttempts) => {
	numAttempts = (numAttempts || 0);

	await throttler(); // https://platform.openai.com/account/rate-limits
	try {
		// https://stackoverflow.com/questions/75396481/openai-gpt-3-api-error-this-models-maximum-context-length-is-4097-tokens
		const sliceTo = 2000;
		const chatCompletion =
				await openai.createChatCompletion({
				  model: "gpt-3.5-turbo",
				  messages: [{role: "user", content: query.slice(0, sliceTo)}],
				});
		return chatCompletion.data.choices[0].message.content;
	} catch (error) {
  	console.log(error);
    if (numAttempts < 3) {
    	console.log("Was an error, trying again...");
    	return await askTruncated(throttler, openai, query, numAttempts + 1);
    } else {
    	console.log("Too many attempts, stopping.");
	    if (typeof error.json === "function") {
	      await error.json().then(jsonError => {
	        console.log("Json error from API");
	        console.log(jsonError);
	      }).catch(genericError => {
	        console.log("Generic error from API");
	        console.log(error.statusText);
	      });
	    } else {
	      console.log("Fetch error");
	      console.log(error);
	    }
    	throw error;
    }
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
export async function analyzePage(throttler, steps, openai, page_text, event_name, event_city, event_state) {
	const describe_question =
			"Below the dashes is a webpage. is it describing a yearly event, yearly competition, yearly gathering, yearly festival, yearly celebration? if none of the above, please only say \"nothing\" and nothing else. if there are multiple, only say \"multiple\" and nothing else. if it is one of those things however, please give me a paragraph of max 20 sentences describing it, including the event's name, city, state, whether it happens every year, what month it's on, the first date of the event, most recent date of the event, future date of the event, and the year it ended.";

	console.log("Asking GPT to describe...");
	steps.push("Asking GPT to describe...");
	const description =
		await askTruncated(throttler, openai, describe_question + "\n------\n" + page_text);
	console.log("GPT:");
	console.log(description);
	steps.push(description);

	if (description.trim().toLowerCase().startsWith("nothing")) {
		console.log("Not an event, skipping.");
		return [0, null];
	}
	if (description.trim().toLowerCase().startsWith("multiple")) {
		console.log("Multiple events, skipping.");
		return [5, null];
	}
	if (description.trim().length < 20) {
		console.log("Too short, probably bad, skipping.");
		return [0, null];
	}

	const analyze_question = 
			"below the dashes is a description of an event. please answer the following questions, numbered, each on their own line.\n" +
			"1. does the event happen every year? say \"yes\", \"no\", or if not known then \"unknown\"\n" +
			"2. what's the event's name?\n" +
			"3. what city is the event held in? say \"unknown\" if not known.\n" +
			"4. what state is the event held in? say \"unknown\" if not known.\n" +
			"5. when did the event first happen? say \"unknown\" if not known.\n" +
			"6. when was the last event? say \"unknown\" if not known.\n" +
			"7. when will the event happen again? say \"unknown\" if not known.\n" +
			"8. what month does the event happen on? say \"unknown\" if not known.\n" +
			"9. what's a one-sentence description of the event?\n" +
			"10. is it referring to or describing or talking about the {event_name} event in {city_name}, {state_name}? start your answer with \"yes\" or \"no\", if no then say why.\n" +
			"11. is it referring to or describing or talking about the {event_name} event in {state_name}? start your answer with \"yes\" or \"no\", if no then say why.\n" +
			"12. is it referring to or describing or talking about the {event_name} event? start your answer with \"yes\" or \"no\", if no then say why.\n" +
			"13. does the description describe multiple different events?\n"

	console.log("Asking GPT to analyze...");
	steps.push("Asking GPT to analyze...");
	const analysisResponse =
		await askTruncated(throttler, openai, analyze_question + "\n------\n" + description);
	console.log("GPT:")
	console.log(analysisResponse);
	steps.push(analysisResponse);

	function startsWithUnknown(line) {
		return /[\d\s\."]unknown/i.test(line);
	}
	function startsWithYes(line) {
		return /[\d\s\."]yes/i.test(line);
	}
	function startsWithNo(line) {
		return /[\d\s\."]no/i.test(line);
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
	const matches = {
		city: null,
		state: null,
		anywhere: null
	}


	for (const lineUntrimmed of analysisResponse.split("\n")) {
		const line = lineUntrimmed.trim().replace(/"/g, "");
		const answerParts = /[\s\d\."]*(.*)/i.exec(line);
		if (!answerParts || !answerParts[1]) {
			continue;
		}
		const answer = answerParts[1];

		// const lineLower = lineLower.toLowerCase();
		if (/^1\b/.test(line)) {
			analysis.yearly = getStartBoolOrNull(line);
		} else if (/^2\b/.test(line)) {
			analysis.name = isKnownTrueOrNull(line) && normalizeName(answer, event_city, event_state);
		} else if (/^3\b/.test(line)) {
			analysis.city = isKnownTrueOrNull(line) && answer;
		} else if (/^4\b/.test(line)) {
			analysis.state = isKnownTrueOrNull(line) && answer;
		} else if (/^5\b/.test(line)) {
			analysis.firstDate = isKnownTrueOrNull(line) && answer;
		} else if (/^6\b/.test(line)) {
			analysis.lastDate = isKnownTrueOrNull(line) && answer;
		} else if (/^7\b/.test(line)) {
			analysis.nextDate = isKnownTrueOrNull(line) && answer;
		} else if (/^8\b/.test(line)) {
			analysis.month = isKnownTrueOrNull(line) && getMonthOrNull(answer);
		} else if (/^9\b/.test(line)) {
			analysis.summary = isKnownTrueOrNull(line) && answer;
		} else if (/^10\b/.test(line)) {
			matches.city = getStartBoolOrNull(line);
		} else if (/^11\b/.test(line)) {
			matches.state = getStartBoolOrNull(line);
		} else if (/^12\b/.test(line)) {
			matches.anywhere = getStartBoolOrNull(line);
		} else if (/^13\b/.test(line)) {
			if (getStartBoolOrNull(line) !== false) {
				// multiple events
				return [5, null];
			}
		}
	}

	if (matches.city) {
		return [4, analysis];
	} else if (matches.state) {
		return [3, analysis];
	} else if (matches.anywhere) {
		return [2, analysis];
	} else {
		return [1, analysis];
	}
}

export async function compareEvents(throttler, steps, openai, page_text, event_name, event_city, event_state) {
	console.log("Comparing 1/4...");
	const describing_1_question =
			"After the below dashes is the text from a webpage. " +
			"Does this webpage say that there is a " + event_name + " event in " + event_state + "? " +
			"If it is, please only say \"Yes.\" " +
			"If not, please start your answer with \"No.\" and then explain how it's different. ";
	steps.push(describing_1_question);
	const describing_1_response =
		await askTruncated(throttler, openai, describing_1_question + "\n------\n" + page_text);
	steps.push(describing_1_response);
	const describing_1 = describing_1_response.trim().toLowerCase().startsWith("yes");
	if (describing_1) {
		return true
	}

	console.log("Comparing 2/4...");
	const describing_2_question =
			"After the below dashes is the text from a webpage. " +
			"Does this webpage say that there is a " + event_name + " event in " + event_city + " in " + event_state + "? " +
			"If it is, please only say \"Yes.\" " +
			"If not, please start your answer with \"No.\" and then explain how it's different. ";
	steps.push(describing_2_question);
	const describing_2_response =
		await askTruncated(throttler, openai, describing_2_question + "\n------\n" + page_text);
	steps.push(describing_2_response);
	const describing_2 = describing_2_response.trim().toLowerCase().startsWith("yes");
	if (describing_2) {
		return true
	}

	const describing = describing_1 || describing_2;

	console.log("Comparing 3/4...");
	const talking_about_question =
			"After the below dashes is the text from a webpage. " +
			"Does this webpage say that the " + event_name + " event is or will be in " + event_state + "? " +
			"If it is, please only say \"Yes.\" " +
			"If not, please start your answer with \"No.\" and then explain how it's different. ";
	steps.push(talking_about_question);
	const talking_about_response =
		await askTruncated(throttler, openai, talking_about_question + "\n------\n" + page_text);
	steps.push(talking_about_response);
	const talking_about = talking_about_response.trim().toLowerCase().startsWith("yes")
	if (talking_about) {
		return true
	}

	console.log("Comparing 4/4...");
	const referring_question =
			"After the below dashes is the text from a webpage. " +
			"Is it referring to the " + event_name + " event in " + event_state + "? " +
			"If it is, please only say \"Yes.\" " +
			"If not, please start your answer with \"No.\" and then explain how it's different. ";
	steps.push(referring_question);
	const referring_response =
		await askTruncated(throttler, openai, referring_question + "\n------\n" + page_text);
	steps.push(referring_response);
	const referring = referring_response.trim().toLowerCase().startsWith("yes");
	if (referring) {
		return true
	}

	return false
}

export async function interrogatePage(throttler, steps, openai, page_text) {
	console.log("Asking about month...");
	const month_question =
	  "After the below dashes is the text from a webpage, describing an event. What month is the event?";
	steps.push(month_question);
	const month_response =
		await askTruncated(throttler, openai, month_question + "\n------\n" + page_text);
	steps.push(month_response);
	const match =
		/(january|february|march|april|may|june|july|august|september|october|november|december)/i.exec(month_response);
	const month = match && match.length > 1 && match[1] || "unknown";

	console.log("Asking if recurring...");
	const recurring_question =
  	"After the below dashes is the text from a webpage, describing an event. Has this event happened multiple times? Please answer only yes or no.";
  steps.push(recurring_question);
	const recurring_response =
		await askTruncated(throttler, openai, recurring_question + "\n------\n" + page_text);
	steps.push(recurring_response);
	const recurring = recurring_response.trim().toLowerCase().startsWith("yes");

	console.log("Asking if planned...");
	const planned_question =
		"After the below dashes is the text from a webpage, describing an event. Does the page say that this event will happen again at some point? Please only answer with \"yes\" or \"no\" and the date, nothing else.";
	steps.push(planned_question);
	const planned_response =
		await askTruncated(throttler, openai, planned_question + "\n------\n" + page_text);
	steps.push(planned_response);
	const planned = planned_response.trim().toLowerCase().startsWith("yes");

	return {
		month: month,
		recurring: recurring,
		planned: planned
	};
}
