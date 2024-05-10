import { Configuration, OpenAIApi } from "openai";
import { Semaphore, parallelEachI } from "../Common/parallel.js"

export class ChatGPTRequester {
  constructor(openAiApiKey) {
    const configuration =
        new Configuration({
            organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
            apiKey: openAiApiKey,
        });
    this.openai = new OpenAIApi(configuration);

    this.throttler = new Semaphore(null, 120);

    this.smart = true;
  }

  slice(query, maybeMaxTokens) {
    // https://stackoverflow.com/questions/75396481/openai-gpt-3-api-error-this-models-maximum-context-length-is-4097-tokens
    const maxTokens = maybeMaxTokens || (4000 * 0.5);
    const sliceTo = (4000 - maxTokens) * 4;
    const slicedQuery = query.slice(0, sliceTo);
    return slicedQuery;
  }

  async request(slicedQuery, maxTokens, throttlerPriority, maybeIdForLogging) {
    return await this.requestInner(slicedQuery, maxTokens, throttlerPriority, maybeIdForLogging, 0);
  }

  async requestInner(slicedQuery, maxTokens, throttlerPriority, maybeIdForLogging, numAttempts) {
    console.log("OpenAI expensive", maybeIdForLogging, "ChatGPT:", slicedQuery);
    // debugger;
  	numAttempts = (numAttempts || 0);
  	if (typeof slicedQuery != 'string') {
  		throw "slicedQuery must be string! Was: " + typeof query;
  	}

    if (slicedQuery != this.slice(slicedQuery, maxTokens)) {
      console.error("Forgot to slice query!");
      process.exit(1);
    }

  	// https://platform.openai.com/account/rate-limits
  	return await this.throttler.prioritized(throttlerPriority, async () => {
  		console.log("Released for GPT!", throttlerPriority)
  		try {
  			// console.log("Asking GPT:", slicedQuery);
  			const chatCompletion =
  					await this.openai.createChatCompletion({
  					  model: "gpt-3.5-turbo",
              max_tokens: maxTokens,
  					  messages: [{role: "user", content: slicedQuery}],
  					});
  			return chatCompletion.data.choices[0].message.content;
  		} catch (error) {
  	  	console.log("Error:", error);
  	    if (numAttempts < 3) {
  	    	console.log("Was an error, trying again...");
  	    	return await this.requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, numAttempts + 1);
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
  	});
  }
}
