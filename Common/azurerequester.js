import { Semaphore, parallelEachI } from "../Common/parallel.js"

export class AzureRequester {
  constructor(endpoint, azureApiKey, requestAssembler) {
    this.throttler = new Semaphore(null, 1200); // 60 requests per min is max
    this.requestAssembler = requestAssembler;
    this.endpoint = endpoint;
    this.azureApiKey = azureApiKey;
    this.smart = true;
  }

  async request(query, maxTokens, throttlerPriority, maybeIdForLogging) {
    return await this.requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, 0);
  }

  async requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, numAttempts) {
    console.log("Azure expensive", maybeIdForLogging, "ChatGPT:", query.slice(0, 100));
    // debugger;
    numAttempts = (numAttempts || 0);
    if (typeof query != 'string') {
      throw "Query must be string! Was: " + typeof query;
    }

    return await this.throttler.prioritized(throttlerPriority, async () => {
      console.log("Released for GPT!", throttlerPriority)

      try {
        const url = this.endpoint + "/v1/chat/completions";
        const requestBody = (this.requestAssembler)(query);
        const response =
            await fetch(
              url,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": this.azureApiKey
                },
                body: JSON.stringify(requestBody)
              });
        if (!response.ok) {
          console.log("For request:", JSON.stringify(requestBody));
          console.log("Response not ok:", response.statusText, response);
          const responseText = await response.text();
          console.log("Response not ok:", responseText);
          throw "Response not ok: " + JSON.stringify(response.statusText) + " " + responseText;
        }
        let body;
        try {
          body = await response.json();
        } catch (e) {
          const bodyText = await response.text();
          console.log("Response wasn't json:", bodyText);
          throw "Response wasn't json: " + bodyText;
        }
        if (!body) {
          console.log("Null body from Azure!", body)
          process.exit(1)
        }
        if (!body.choices) {
          console.log("No choices from Azure!", body)
          process.exit(1)
        }
        if (body.choices.length != 1) {
          for (const choice of body.choices) {
            const message = await choice.message;
            console.log("Message:", message);
          }
          console.log("Not =1 choices from Azure!", body)
          process.exit(1)
        }
        const content = (await body.choices[0]).message.content;
        if (content.includes("sys>") || content.includes("[/s]") || content.includes("[inst]")) {
          console.log("Whole response:", body);
          throw "Bad response, starting with:" + content.slice(0, 100);
        }
        return content;
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
