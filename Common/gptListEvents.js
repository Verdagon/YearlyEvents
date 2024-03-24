import { normalizeName } from "./utils.js";
import { askTruncated } from "./gptUtils.js";

export async function gptListEvents(openai, throttler, question) {
	const query =
			question + ". Do not number the responses, and please format " +
			"the response in semicolon-separated CSV format where the four columns are the name, " +
			"the city, the state, and a max two-sentence description including anything unique or unusual. Please say nothing else.";

	const response =
			await openai.createChatCompletion({
				  model: "gpt-3.5-turbo",
				  messages: [{role: "user", content: query}],
			});
	const response_string = response.data.choices[0].message.content;
	const eventStrings = response_string.split("\n")

	const results = [];
	for (let i = 1; i < eventStrings.length; i++) {
		const eventString = eventStrings[i].trim()
		if (eventString == "") {
			continue
		}
		if (/^\d+/.test(eventString)) {
			console.log("Skipping malformed event string that started with number: " + eventString)
			continue
		}
		const eventStringParts = eventString.split(";")
		if (eventStringParts.length < 4) {
			console.log("Skipping malformed event string: " + eventString)
			continue
		}

		const originalEventName = eventStringParts[0].trim();
		const city = eventStringParts[1].trim()
		const state = eventStringParts[2].trim()
		const description = eventStringParts[3].trim();

		const name = normalizeName(originalEventName, city, state);

		results.push({name, city, state, description});
	}

	return results;
}
