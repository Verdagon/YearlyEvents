import { Configuration, OpenAIApi } from "openai";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const apiKey = process.argv[2];
if (!apiKey) {
	throw "Supply OpenAI API key as first argument";
}

const question = process.argv[3];
if (!question) {
	throw "Supply question as second argument";
}

const configuration =
		new Configuration({
		    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		    apiKey: apiKey,
		});
const openai = new OpenAIApi(configuration);
const response = await openai.listEngines();

const query =
		question + ". Do not number the responses, and please format " +
		"the response in semicolon-separated CSV format where the columns are the name, usual " +
		"month of the year, town, and max two-sentence description. Please say nothing else.";

await delay(1000);

const chatCompletion =
		await openai.createChatCompletion({
			  model: "gpt-3.5-turbo",
			  messages: [{role: "user", content: query}],
		});
const response_string = chatCompletion.data.choices[0].message.content;
const results = response_string.split("\n")

// Skip first line which is CSV header.
for (let i = 1; i < results.length; i++)
	console.log(results[i]);
