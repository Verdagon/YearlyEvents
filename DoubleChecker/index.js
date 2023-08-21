import { Configuration, OpenAIApi } from "openai";

import fs from "fs/promises";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))


const askTruncated = async (openai, query, numAttempts) => {
	numAttempts = (numAttempts || 0);

	await delay(1000 + (numAttempts * 4000)); // https://platform.openai.com/account/rate-limits
	try {
		const chatCompletion =
				await openai.createChatCompletion({
				  model: "gpt-3.5-turbo",
				  // Sliced because: "This model's maximum context length is 4097 tokens. However, your
				  // messages resulted in 4277 tokens. Please reduce the length of the messages."
				  messages: [{role: "user", content: query.slice(0, 4050)}],
				});
		return chatCompletion.data.choices[0].message.content;
	} catch (error) {
    if (numAttempts < 3) {
    	console.log("Was an error, trying again...");
    	return await askTruncated(query, numAttempts + 1);
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



const askCachedTruncated = async (cacheId, query, numAttempts) => {
	const requestPathInCache = "chatcache/" + cacheId + ".request.txt";
	const responsePathInCache = "chatcache/" + cacheId + ".response.txt";
	try {
		const response = await fs.readFile(responsePathInCache, { encoding: 'utf8' });
		if (!response) {
			throw "Not in cache";
		}
		return response;
	} catch (e) {
		const response = await askTruncated(query, numAttempts);
		await fs.writeFile(requestPathInCache, query);
		await fs.writeFile(responsePathInCache, response);
		return response;
	}
}


async function describes(event_name, event_state, fetched_text) {
	const describing_response =
		await askCachedTruncated(
			"doublecheck:describing:" + event_state + ":" + event_name,
			"After the below dashes is the text from a webpage.\n" +
			"Is this webpage describing the " + event_name + " event in " + event_state + "?\n" +
			"If it is, please only say \"Yes.\"\n" +
			"If not, please start your answer with \"No.\" and then explain how it's different.\n\n------\n" +
			fetched_text);
	const describing = !describing_response.trim().toLowerCase().startsWith("no");
	if (describing) {
		return true;
	}

	const talking_about_response =
		await askCachedTruncated(
			"doublecheck:talking:" + event_state + ":" + event_name,
			"After the below dashes is the text from a webpage.\n" +
			"Is this webpage talking about the " + event_name + " event in " + event_state + "?\n" +
			"If it is, please only say \"Yes.\"\n" +
			"If not, please start your answer with \"No.\" and then explain how it's different.\n\n------\n" +
			fetched_text);
	const talking_about = !talking_about_response.trim().toLowerCase().startsWith("no")
	if (talking_about) {
		return true;
	}

	const referring_response =
		await askCachedTruncated(
			"doublecheck:referring:" + event_state + ":" + event_name,
			"After the below dashes is the text from a webpage.\n" +
			"Is it referring to the " + event_name + " event in " + event_state + "?\n" +
			"If it is, please only say \"Yes.\"\n" +
			"If not, please start your answer with \"No.\" and then explain how it's different.\n\n------\n" +
			fetched_text);
	const referring = !referring_response.trim().toLowerCase().startsWith("no");
	if (referring) {
		return true;
	}

	console.log("not-same:\n" + describing_response + "\n" + talking_about_response + "\n" + referring_response);
	return false;
}

async function compareEvents(apiKey, search_result_fetched_text_file_path, event_name, event_city, event_state) {
	const search_result_fetched_text =
			(await fs.readFile(search_result_fetched_text_file_path, { encoding: 'utf8' }));

	const configuration =
			new Configuration({
			    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
			    apiKey: apiKey,
			});
	const openai = new OpenAIApi(configuration);

	if (await describes(event_name, event_state, search_result_fetched_text)) {
		const month_response =
			await askTruncated(
				openai,
				"After the below dashes is the text from a webpage, describing an event.\n" +
				"What month is the event?\n\n------\n" +
				search_result_fetched_text);
		const match =
			/(january|february|march|april|may|june|july|august|september|october|november|december)/i.exec(month_response);
		const month = match && match.length > 1 && match[1] || "unknown";

		const recurring_response =
			await askTruncated(
				openai,
				"After the below dashes is the text from a webpage, describing an event.\n" +
				"Has this event happened multiple times? Please answer only yes or no.\n\n------\n" +
				search_result_fetched_text);
		const recurring = !recurring_response.trim().toLowerCase().startsWith("no");

		const planned_response =
			await askTruncated(
				openai,
				"After the below dashes is the text from a webpage, describing an event.\n" +
				"Will this event happen again at some point? Please start your answer with \"yes\" or \"no\". If yes, what date?\n\n------\n" +
				search_result_fetched_text);
		const planned = !planned_response.trim().toLowerCase().startsWith("no");

		const promising = recurring || planned;

		console.log("yes " + month + (promising ? " promising" : "dubious"));
	}
}

// const apiKey = process.argv[2];
// if (!apiKey) {
// 	throw "Supply OpenAI API key as first argument";
// }

// const search_result_fetched_text_file_path = process.argv[3];
// if (!search_result_fetched_text_file_path) {
// 	throw "Supply search result fetched text file path as second argument";
// }

// const event_name = process.argv[4];
// if (!event_name) {
// 	throw "Supply event name as third argument";
// }

// const event_city = process.argv[5];
// if (!event_city) {
// 	throw "Supply usual event location as fourth argument";
// }

// const event_state = process.argv[6];
// if (!event_state) {
// 	throw "Supply usual event location as fourth argument";
// }

// await doublecheck(apiKey, search_result_fetched_text_file_path, event_name, event_city, event_state)

module.exports = {
  compareEvents: compareEvents
};