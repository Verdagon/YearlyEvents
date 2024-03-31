
import { Semaphore, parallelEachI } from "../Common/parallel.js"

export class ChatGPTRequester {
  constructor(openai) {
    this.throttler = new Semaphore(null, 120);
    this.openai = openai;
  }

  async request(query, throttlerPriority, maybeIdForLogging) {
    return await this.requestInner(query, throttlerPriority, maybeIdForLogging, 0);
  }

  async requestInner(query, throttlerPriority, maybeIdForLogging, numAttempts) {
    console.log("Expensive", maybeIdForLogging, "ChatGPT:", query.slice(0, 100));
    // debugger;
  	numAttempts = (numAttempts || 0);
  	if (typeof query != 'string') {
  		throw "Query must be string! Was: " + typeof query;
  	}

  	// https://platform.openai.com/account/rate-limits
  	return await this.throttler.prioritized(throttlerPriority, async () => {
  		console.log("Released for GPT!", throttlerPriority)
  		try {
  			// https://stackoverflow.com/questions/75396481/openai-gpt-3-api-error-this-models-maximum-context-length-is-4097-tokens
  			const sliceTo = 2000;
  			const slicedQuery = query.slice(0, sliceTo);
  			// console.log("Asking GPT:", slicedQuery);
  			const chatCompletion =
  					await this.openai.createChatCompletion({
  					  model: "gpt-3.5-turbo",
  					  messages: [{role: "user", content: slicedQuery}],
  					});
  			return chatCompletion.data.choices[0].message.content;
  		} catch (error) {
  	  	console.log(error);
  	    if (numAttempts < 3) {
  	    	console.log("Was an error, trying again...");
  	    	return await this.requestInner(query, throttlerPriority, maybeIdForLogging, numAttempts + 1);
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