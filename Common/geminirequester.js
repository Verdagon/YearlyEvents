import { Semaphore, parallelEachI } from "../Common/parallel.js"
import { GoogleGenerativeAI } from "@google/generative-ai";

// This is so high because it's rarely the fault of the network or anything normal,
// they just don't have enough servers:
// https://github.com/google/generative-ai-python/issues/236
const MAX_TRIES = 20;

async function printResponseError(error, prefix = "") {
  if (typeof error.json === "function") {
    try {
      const jsonError = await error.json();
      console.log((prefix || "") + "Json error from API:", jsonError);
    } catch (genericError) {
      if (genericError.statusText) {
        console.log((prefix || "") + "Generic error from API:", genericError.statusText);
      }
      console.log((prefix || "") + "Unknown error:", error);
    }
    return;
  }

  if (error.message) {
    if (error.message.includes("500 Internal Server Error")) {
      console.log((prefix || "") + "Encountered 500 error.");
    } else {
      console.log((prefix || "") + error.message);
    }
    return;
  }
  console.log((prefix || "") + "Response error:", error);
}

export class GeminiRequester {
  constructor(geminiApiKey, successCounter, failedCounter, censoredCounter) {
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-pro"});
    this.model.safetySettings = [
      {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: "BLOCK_NONE"},
      {category: 'HARM_CATEGORY_HARASSMENT', threshold: "BLOCK_NONE"},
      {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: "BLOCK_NONE"},
      {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: "BLOCK_NONE"}
    ];

    this.throttler = new Semaphore(null, 1200); // 60 requests per min is max
    this.successCounter = successCounter;
    this.failedCounter = failedCounter;
    this.censoredCounter = censoredCounter;
    this.smart = true;
  }

  async request(query, maxTokens, throttlerPriority, maybeIdForLogging) {
    return await this.requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, 0);
  }

  async requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, numAttempts) {
    try {
      return await this.throttler.prioritized(throttlerPriority, async () => {
        console.log("Released for GPT!", throttlerPriority)
        const result = await this.model.generateContent(query);
        const response = await result.response;
        this.successCounter.count++;
        return response.text();
      });
    } catch (error) {
      if (error.message && error.message.includes("Response was blocked due to SAFETY")) {
        this.censoredCounter.count++;
        // Don't retry
        throw "Gemini response was censored.";
      }
      if (numAttempts < MAX_TRIES) {
        await printResponseError(error, "Retrying after error:");
        return await this.requestInner(query, maxTokens, throttlerPriority, maybeIdForLogging, numAttempts + 1);
      } else {
        await printResponseError(error, "No more retries after error:");
        this.failedCounter.count++;
        if (error.message.includes("500 Internal Server Error")) {
          throw "500 Internal Server Error";
        } else {
          throw error;
        }
      }
    }
  }
}
