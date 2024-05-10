import { Semaphore, parallelEachI } from "../Common/parallel.js"

const SYSTEM_PROMPT = "You are a helpful assistant. Be as concise as possible. Do not preface or preamble your answers, and don't restate the question. When responding with a grammatically incomplete sentence sufficiently clearly answers a question, then do so.";

export class OllamaRequester {
  constructor(endpoint, model, totalMaxTokens, smart) {
    this.throttler = new Semaphore(1, null); // 60 requests per min is max
    this.model = model;
    this.endpoint = endpoint;
    this.smart = smart;
    this.totalMaxTokens = totalMaxTokens;
  }

  async request(query, outputMaxTokens, throttlerPriority, maybeIdForLogging) {
    if (outputMaxTokens === undefined) {
      var stack = new Error().stack
      console.log( stack )
    }
    if (!outputMaxTokens) {
      outputMaxTokens = Math.floor(this.totalMaxTokens / 2);
    }
    query = query.slice(0, (this.totalMaxTokens - outputMaxTokens) * 4);
    return await this.requestInner(query, outputMaxTokens, throttlerPriority, maybeIdForLogging, 0);
  }

  async requestInner(query, outputMaxTokens, throttlerPriority, maybeIdForLogging, numAttempts) {
    console.log("Ollama expensive", maybeIdForLogging, "ChatGPT:", query);
    console.log("Ollama", outputMaxTokens, throttlerPriority, numAttempts);
    // debugger;
    numAttempts = (numAttempts || 0);
    if (typeof query != 'string') {
      throw "Query must be string! Was: " + typeof query;
    }

    try {
      return await this.throttler.prioritized(throttlerPriority, async () => {
        console.log("Released for GPT!", throttlerPriority)

        const url = this.endpoint;
        const requestBody = {
          "model": this.model,
          "messages": [{ "role": "user", "content": query }],
          "system": SYSTEM_PROMPT,
          "stream": false
        };
        if (outputMaxTokens) {
          requestBody.options = requestBody.options || {};
          requestBody.options.num_predict = outputMaxTokens;
        }
        const response =
            await fetch(
              url,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
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
          console.log("Null body from Ollama!", body)
          process.exit(1)
        }
        if (!body.message) {
          console.log("No message from Ollama!", body)
          process.exit(1)
        }
        const content = await body.message.content;
        if (content.includes("sys>") || content.includes("[/s]") || content.includes("[inst]")) {
          console.log("Whole response:", body);
          throw "Bad response, starting with:" + content.slice(0, 100);
        }
        console.log("Response content:", content);
        return content;
      });
    } catch (error) {
      console.log(error);
      if (numAttempts < 3) {
        console.log("Was an error, trying again...");
        return await this.requestInner(query, outputMaxTokens, throttlerPriority, maybeIdForLogging, numAttempts + 1);
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
}
