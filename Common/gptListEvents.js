import { normalizeName } from "./utils.js";

export async function makeNewConversation(db, question, seedState) {
	const query =
			question + ". Do not number the responses, and please format " +
			"the response in headerless semicolon-separated CSV format where the four columns are the name, " +
			"the city, the state, and a max two-sentence description including anything unique or unusual. Please say nothing else.";
	const conversation = [{role: "user", content: query}];

	if (seedState) {
		const rows =
				(await db.findApprovedSubmissionsAt(seedState, 30))
          .filter(submission => submission.city && submission.state)
					.map(submission => {
						const description =
								submission.description ||
										("Event where folks gather to partake in " + submission.name + " in " + submission.city);
						return submission.name + ";" + submission.city + ";" + submission.state + ";" + description;
					})
					.join("\n");
		conversation.push({ "role": "assistant", "content": rows });
		conversation.push({ "role": "user", "content": "More, please." });
	}

	return conversation;
}

export function continuedConversation(pastConversation) {
	return pastConversation.concat([{role: "user", content: "More, please."}]);
}

export async function gptListEvents(openai, throttler, conversation) {
	console.log("Sending whole conversation:", conversation);
	const response =
			await openai.createChatCompletion(
					{model: "gpt-3.5-turbo", messages: conversation});
	const response_string = response.data.choices[0].message.content;
	const eventStrings = response_string.split("\n")

	const results = [];
	for (let i = 0; i < eventStrings.length; i++) {
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

	conversation.push({role: "assistant", content: response_string});

	return results;
}
