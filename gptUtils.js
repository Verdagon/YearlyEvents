
export async function askTruncated(throttler, openai, query, numAttempts) {
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
