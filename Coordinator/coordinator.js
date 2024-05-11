// challenges, competitions, festivals, events, celebrations

import syncFs from "fs";
import http from "http";
import https from "https";
import util from 'node:util';
import { AzureRequester } from "../Common/azurerequester.js";
import { GeminiRequester } from "../Common/geminirequester.js";
import { ChatGPTRequester } from "../Common/chatgptrequester.js";
import { OllamaRequester } from "../Common/ollamarequester.js";
import { execFile, spawn } from 'node:child_process'
import { delay } from "../Common/parallel.js";
import { LocalDb } from '../LocalDB/localdb.js'
// import { getUnanalyzedSubmissions } from '../getUnanalyzedSubmissions.js'
import { addSubmission } from '../Common/addSubmission.js'
import { getSearchResultOuter } from "./search.js"
import fs from "fs/promises";
import { logs, deloggify, deloggifyEntry, normalizeName, makeLineServerProcess } from "../Common/utils.js";
import { investigate } from "./investigate.js";
import { analyzePageOuter, analyzeMatchOuter } from './analyze.js'
import { Configuration, OpenAIApi } from "openai";
import { Semaphore, parallelEachI, makeMsThrottler } from "../Common/parallel.js";
import urlencode from 'urlencode';

function toMap(entries, allowDuplicates) {
  const result = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry)) {
      throw "toMap entries isn't array."
    }
    if (entry.length != 2) {
      throw "toMap: Entry array length isn't 2."
    }
    const [key, value] = entry;
    if (!allowDuplicates && result.has(key)) {
      throw "toMap: Duplicate key: " + key;
    }
    result.set(key, value);
  }
  return result;
}

function printExampleUsage() {
  console.log("Example usage:")
  console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 geminiKeyHere789 scratch");
}

const args = [...process.argv];

const keysFile = args[2]
args.splice(2, 1)
if (!keysFile) {
  console.log("Please supply a keys file argument.")
  printExampleUsage();
  process.exit(1)
}
if (!syncFs.existsSync(keysFile)) {
  console.log("Keys file not found!")
  printExampleUsage();
  process.exit(1)
}

const scratchDir = args[2]
args.splice(2, 1)
if (!scratchDir) {
	console.log("Please enter the scratch dir argument.")
  printExampleUsage();
	process.exit(1)
}

let retryErrors = false;
const retryErrorsIndex = args.indexOf("--retry-errors");
if (retryErrorsIndex >= 0) {
  retryErrors = true;
  args.splice(retryErrorsIndex, 1);
}

let filterSubmissionId = null;
const filterSubmissionIdIndex = args.indexOf("--filter-submission-id");
if (filterSubmissionIdIndex >= 0) {
  const [_, filterSubmissionId_] = args.splice(filterSubmissionIdIndex, 2);
  if (!filterSubmissionId_) {
    throw "Bad --filter-submission-id argument!";
  }
  filterSubmissionId = filterSubmissionId_;
}

let filterStatus = 'approved';
const filterStatusIndex = args.indexOf("--filter-status");
if (filterStatusIndex >= 0) {
  const [_, filterStatus] = args.splice(filterStatusIndex, 2);
  if (!filterStatus) {
    throw "Bad --filter-status argument!";
  }
}

let filterNeed = 2;
const filterNeedIndex = args.indexOf("--filter-need");
if (filterNeedIndex >= 0) {
  const [_, newFilterNeed] = args.splice(filterNeedIndex, 2);
  if (newFilterNeed == null) {
    throw "Bad --filter-need argument!";
  }
  if (newFilterNeed != newFilterNeed - 0) {
    throw "--filter-need should be integer";
  }
  filterNeed = newFilterNeed - 0;
}

let limit = null;
const limitIndex = args.indexOf("--limit");
if (limitIndex >= 0) {
  const [_, newLimit] = args.splice(limitIndex, 2);
  if (newLimit == null) {
    throw "Bad --limit argument!";
  }
  if (newLimit != newLimit - 0) {
    throw "--limit should be integer";
  }
  limit = newLimit - 0;
}

if (args.length != 2) {
  console.error("Un-processed args:", args);
  process.exit(1);
}

const keys =
    toMap(
        (await fs.readFile(keysFile, { encoding: 'utf8' }))
        .trim()
        .split("\n")
        .filter(line => !!line)
        .map(line => {
          const [key, value] = line.split("=");
          return [key, value];
        }));

const openAiApiKey = keys.get("OPEN_AI_KEY");
const googleSearchApiKey = keys.get("GOOGLE_SEARCH_KEY");
const geminiAPIKey = keys.get("GEMINI_KEY");
const MISTRAL_LARGE_MAX_QUERY_TOKENS = 25000;
const MISTRAL_LARGE_MAX_TOTAL_TOKENS = 32768;
const mistralApiKey = keys.get("MISTRAL_AZURE_API_KEY");
const mistralEndpoint = keys.get("MISTRAL_AZURE_ENDPOINT");
const LLAMA_2_70B_MAX_QUERY_TOKENS = 3072;
const LLAMA_2_70B_MAX_TOTAL_TOKENS = 4096;
const llama270BApiKey = keys.get("LLAMA_2_70B_AZURE_API_KEY");
const llama270BEndpoint = keys.get("LLAMA_2_70B_AZURE_ENDPOINT");
const LLAMA_2_13B_MAX_QUERY_TOKENS = 3072;
const LLAMA_2_13B_MAX_TOTAL_TOKENS = 4096;
const llama213BApiKey = keys.get("LLAMA_2_13B_AZURE_API_KEY");
const llama213BEndpoint = keys.get("LLAMA_2_13B_AZURE_ENDPOINT");
const COHERE_MAX_QUERY_TOKENS = 25000;
const COHERE_MAX_TOTAL_TOKENS = 32768; // cohere can actually go up to like 128k
const cohereApiKey = keys.get("COHERE_AZURE_API_KEY");
const cohereEndpoint = keys.get("COHERE_AZURE_ENDPOINT");

const chromeCacheCounter = { count: 0 };
const searchCacheCounter = { count: 0 };
const gptCacheCounter = { count: 0 };
const geminiSuccessCounter = { count: 0 };
const geminiFailedCounter = { count: 0 };
const geminiCensoredCounter = { count: 0 };

const modelToLlmRequester = {
  "cohere-command-r-plus": new AzureRequester(
      cohereEndpoint, cohereApiKey,
      (query) => {
        const effectiveMaxTokens = COHERE_MAX_TOTAL_TOKENS - 318;
        // The subtraction is because for some stupid reason, azure adds 318 more tokens than we supply.
        // My best guess is it's for some sort of hidden system prompt, because that's a *lot*.
        const systemPrompt = "You are a helpful assistant. Be as concise as possible. Do not preface or preamble your answers, and don't restate the question. When responding with a grammatically incomplete sentence sufficiently clearly answers a question, then do so.";
        const maxChars = COHERE_MAX_QUERY_TOKENS * 4;
        const maxQueryChars = maxChars - systemPrompt.length;
        const slicedQuery = query.slice(0, maxQueryChars);
        const queryNumTokens = Math.ceil((systemPrompt.length + slicedQuery.length) / 4);
        const maxTokens = effectiveMaxTokens - queryNumTokens;
        return {
          "messages": [
            {"content": systemPrompt, "role":"system"},
            {"content": slicedQuery, "role":"user"}
          ],
          "max_tokens": maxTokens
        };
      }),
  "mistral-large": new AzureRequester(
      mistralEndpoint, mistralApiKey,
      (query) => {
        const effectiveMaxTokens = MISTRAL_LARGE_MAX_TOTAL_TOKENS - 318;
        // The subtraction is because for some stupid reason, azure adds 318 more tokens than we supply.
        // My best guess is it's for some sort of hidden system prompt, because that's a *lot*.
        const systemPrompt = "You are a helpful assistant. Be as concise as possible. Do not preface or preamble your answers, and don't restate the question. When a grammatically incomplete sentence sufficiently clearly answers a question, then do so.";
        const maxChars = MISTRAL_LARGE_MAX_QUERY_TOKENS * 4;
        const maxQueryChars = maxChars - systemPrompt.length;
        const slicedQuery = query.slice(0, maxQueryChars);
        const queryNumTokens = Math.ceil((systemPrompt.length + slicedQuery.length) / 4);
        const maxTokens = effectiveMaxTokens - queryNumTokens;
        return {
          "messages": [
            {"content": systemPrompt, "role":"system"},
            {"content": slicedQuery, "role":"user"}
          ],
          "max_tokens": maxTokens
        };
      }),
  "gemini-pro": new GeminiRequester(geminiAPIKey, geminiSuccessCounter, geminiFailedCounter, geminiCensoredCounter),
  "gpt-3.5-turbo": new ChatGPTRequester(openAiApiKey),
  "mistral-7b": new OllamaRequester("http://localhost:11434/api/chat", "mistral", 8192, false),
  "gemma": new OllamaRequester("http://localhost:11434/api/chat", "gemma", 8192, false),
  "llama3-7b-Q4": new OllamaRequester("http://localhost:11434/api/chat", "llama3", 8192, false)
};
// const experimentalLlmRequesterModels = ["cohere-command-r-plus", "llama3-7b-Q4"];
const experimentalLlmRequesterModels = ["cohere-command-r-plus"];

if (!syncFs.existsSync(scratchDir)) {
  console.log("Making scratch dir:", scratchDir);
  syncFs.mkdirSync(scratchDir);
}


const fetchThrottler = new Semaphore(10, null);
const searchThrottler = new Semaphore(10, null);
const dbThrottler = new Semaphore(1, null);

const db = new LocalDb(dbThrottler, null, "./db.sqlite");

let chromeFetcher = null;
try {
	chromeFetcher =
			await makeLineServerProcess(
					'./PageFetcher/target/debug/page_fetcher', [], 'Ready');

  let unfinishedPageLeads = await db.getUnfinishedPageLeads(retryErrors);
  console.log(unfinishedPageLeads.length, "unfinished page leads.");
  await parallelEachI(unfinishedPageLeads, async (leadIndex, lead) => {
    let broadSteps = lead.steps;
    await analyzePageOuter(
        scratchDir,
        db,
        googleSearchApiKey,
        fetchThrottler,
        searchThrottler,
        searchCacheCounter,
        chromeFetcher,
        chromeCacheCounter,
        modelToLlmRequester,
        retryErrors,
        -leadIndex, // throttlerPriority
        gptCacheCounter,
        null,
        "Lead" + leadIndex,
        null,
        null,
        null,
        lead.id,
        broadSteps,
        leadIndex,
        lead.url);

    const pageAnalysisRow =
        await db.getPageAnalysis(lead.url);
    if (pageAnalysisRow.status == 'created') {
      console.log("Page lead analysis row is status created, pausing investigation.");
      // If it's still created status, then we're waiting on something external.
      return;
    } else if (pageAnalysisRow.status == 'success') {
      // proceed
    } else if (pageAnalysisRow.status == 'errors') {
      logs(broadSteps)("Analysis for", lead.url, "had errors, marking page lead.");
      await db.updatePageLead(lead.id, 'errors', broadSteps);
      return;
    } else if (pageAnalysisRow.status == 'rejected') {
      logs(broadSteps)("Analysis for", lead.url, "rejected, marking page lead.");
      await db.updatePageLead(lead.id, 'rejected', broadSteps);
      return;
    } else {
      throw "Weird status from analyze: " + pageAnalysisRow.status;
    }

    logs(broadSteps)("Page lead url", lead.url, "success, adding", lead.status, "submission.");

    const existingId =
        await addSubmission(db, {
            submission_id: lead.id,
            status: lead.future_submission_status == 'approved' ? 'approved' : 'created',
            name: pageAnalysisRow.analysis.name,
            city: pageAnalysisRow.analysis.city || "",
            state: pageAnalysisRow.analysis.state || "",
            description: pageAnalysisRow.analysis.summary,
            url: lead.url,
            origin_query: null,
            need: lead.future_submission_need
        });
    if (existingId != lead.id) {
      logs(broadSteps)("Page lead already has a submission:", existingId);
    }

    lead.status = 'success'; // because its used below
    await db.updatePageLead(lead.id, 'success', broadSteps);
  });


  let unfinishedNameLeads = await db.getUnfinishedNameLeads();
  console.log(unfinishedNameLeads.length, "unfinished name leads.");
  await parallelEachI(unfinishedNameLeads, async (leadIndex, lead) => {
    const broadSteps = [];

    const googleQuery = lead.name;
    const urls =
        await getSearchResultOuter(
            db,
            googleSearchApiKey,
            fetchThrottler,
            searchThrottler,
            searchCacheCounter,
            -leadIndex, // throttlerPriority
            lead.id,
            broadSteps,
            null,
            [],
            googleQuery);
    if (urls == null) {
      logs(broadSteps)("Bad search for name lead!");
      await db.updateNameLead(lead.id, 'error', broadSteps);
      return;
    }
    for (const url of urls) {
      await analyzePageOuter(
          scratchDir,
          db,
          googleSearchApiKey,
          fetchThrottler,
          searchThrottler,
          searchCacheCounter,
          chromeFetcher,
          chromeCacheCounter,
          modelToLlmRequester,
          retryErrors,
          -leadIndex, // throttlerPriority
          gptCacheCounter,
          null,
          "Lead" + leadIndex,
          lead.name,
          null,
          null,
          lead.id,
          broadSteps,
          leadIndex,
          url);

      const pageAnalysisRow =
          await db.getPageAnalysis(url);
      if (pageAnalysisRow.status == 'created') {
        console.log("Name lead analysis row is status created, pausing investigation.");
        // If it's still created status, then we're waiting on something external.
        return;
      } else if (pageAnalysisRow.status == 'success') {
        // proceed
      } else if (pageAnalysisRow.status == 'errors') {
        logs(broadSteps)("Analysis for", url, "had errors, marking lead.");
        await db.updateNameLead(lead.id, 'errors', broadSteps);
        return;
      } else if (pageAnalysisRow.status == 'rejected') {
        logs(broadSteps)("Analysis for", url, "rejected, marking lead.");
        await db.updateNameLead(lead.id, 'rejected', broadSteps);
        return;
      } else {
        throw "Weird status from analyze: " + pageAnalysisRow.status;
      }

      logs(broadSteps)("Lead url", url, "success, adding", lead.status, "submission.");

      const newSubmissionId = crypto.randomUUID();
      const existingId =
          await addSubmission(db, {
              submission_id: newSubmissionId,
              status: 'created',
              name: pageAnalysisRow.analysis.name,
              city: pageAnalysisRow.analysis.city || "",
              state: pageAnalysisRow.analysis.state || "",
              description: pageAnalysisRow.analysis.summary,
              url: url,
              origin_query: lead.name,
              need: 0
          });
      if (existingId != newSubmissionId) {
        logs(broadSteps)("Name lead already has a submission:", existingId);
      }

      lead.status = 'success'; // because its used below
      await db.updateNameLead(lead.id, 'success', broadSteps);
    }
  });


  let scrutinize = null;
  console.log(
      "Filtering submissions:" +
      " status=" + filterStatus +
      " need=" + filterNeed +
      " id=" + filterSubmissionId +
      " scrutinize=" + scrutinize +
      " retryErrors=" + retryErrors +
      " limit=" + limit);
	let approvedSubmissions =
      await db.getProcessibleSubmissions(
          filterStatus, filterNeed, filterSubmissionId, scrutinize, retryErrors, limit);

	console.log("Considering approved submissions:");
	for (const submission of approvedSubmissions) {
		const {
			submission_id: submissionId,
			name: originalEventName,
			state: eventState,
			city: eventCity,
			description: eventDescription,
			url: maybeUrl
		} = submission;
		const eventName = normalizeName(originalEventName, eventCity, eventState);
		console.log("    ", originalEventName, eventCity, eventState);
	}

  const outcomes = [];

	await parallelEachI(approvedSubmissions, async (submissionIndex, submission) => {
		const {
			submission_id: submissionId,
			name: originalEventName,
			state: eventState,
			city: eventCity,
			description: eventDescription,
			url: maybeUrl,
      scrutinize
		} = submission;
		const eventName = normalizeName(originalEventName, eventCity, eventState);
		// Higher ones get prioritized more, and we want the earliest submissions prioritized more.
		const throttlerPriority = -submissionIndex;

		console.log("Starting doublecheck:", eventName, "in", eventCity, eventState, submissionId);

    // Always make sure we have a canonical one first
    console.log("Doing canonical investigation...")
    await investigate(
        scratchDir,
        db,
        googleSearchApiKey,
        fetchThrottler,
        searchThrottler,
        searchCacheCounter,
        chromeFetcher,
        chromeCacheCounter,
        modelToLlmRequester,
        retryErrors,
        throttlerPriority,
        gptCacheCounter,
        submissionIndex,
        eventName,
        eventCity,
        eventState,
        maybeUrl,
        submissionId,
        null);
    
    // The above investigate(...) call updated things in the database for us to now retrieve.
    const investigationRow = await db.getInvestigation(submissionId);

    if (investigationRow.status == 'created') {
      // Continue on, this one's paused on some external thing.
      logs(outcomes)("Concluded nothing yet for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")", submissionId);
      return;
    } else if (investigationRow.status == 'failed') {
      await db.updateSubmissionStatus(submissionId, 'failed');
      logs(outcomes)("Concluded failed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")", submissionId);

    } else if (investigationRow.status == 'confirmed') {
      logs(outcomes)("Concluded confirmed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")", submissionId);

      await db.transaction(async (trx) => {
        await trx.updateSubmissionStatus(submissionId, 'confirmed');
      });
    } else if (investigationRow.status == 'errors') {
      logs(outcomes)("Concluded errors for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")", submissionId);
      await db.updateSubmissionStatus(submissionId, 'errors');
    } else {
      throw "Weird status from investigation: " + investigationRow.status;
    }
	});




  // Scrutinize phase
  scrutinize = true;
  if (filterStatus == 'approved') {
    console.log("filterStatus=1 and scrutinize, so nulling filterStatus.");
    filterStatus = null;
  }
  console.log(
      "Filtering submissions:" +
      " status=" + filterStatus +
      " need=" + filterNeed +
      " id=" + filterSubmissionId +
      " scrutinize=" + scrutinize +
      " retryErrors=" + retryErrors +
      " limit=" + limit);
  let scrutineeSubmissions =
      await db.getProcessibleSubmissions(
          filterStatus, filterNeed, filterSubmissionId, scrutinize, retryErrors, limit);

  console.log("Scrutinizing submissions:");
  for (const submission of scrutineeSubmissions) {
    const {
      submission_id: submissionId,
      name: originalEventName,
      state: eventState,
      city: eventCity,
      description: eventDescription,
      url: maybeUrl
    } = submission;
    const eventName = normalizeName(originalEventName, eventCity, eventState);
    console.log("    ", originalEventName, eventCity, eventState);
  }

  await parallelEachI(scrutineeSubmissions, async (submissionIndex, submission) => {
    const {
      submission_id: submissionId,
      name: originalEventName,
      state: eventState,
      city: eventCity,
      description: eventDescription,
      url: maybeUrl
    } = submission;
    const eventName = normalizeName(originalEventName, eventCity, eventState);
    // Higher ones get prioritized more, and we want the earliest submissions prioritized more.
    const throttlerPriority = -submissionIndex;

    console.log("Starting scrutinize:", eventName, "in", eventCity, eventState, submissionId);

    for (const experimentalModel of experimentalLlmRequesterModels) {
      console.log("Doing experimental investigation:", experimentalModel)
      await investigate(
          scratchDir,
          db,
          googleSearchApiKey,
          fetchThrottler,
          searchThrottler,
          searchCacheCounter,
          chromeFetcher,
          chromeCacheCounter,
          modelToLlmRequester,
          retryErrors,
          throttlerPriority,
          gptCacheCounter,
          submissionIndex,
          eventName,
          eventCity,
          eventState,
          maybeUrl,
          submissionId,
          experimentalModel);
    }
  });



  console.log("Outcomes:");
  for (const outcome of outcomes) {
    console.log("  " + deloggifyEntry(outcome));
  }

	console.log("");
	console.log(searchCacheCounter.count + " search cache hits.");
	console.log(chromeCacheCounter.count + " fetch cache hits.");
	console.log(gptCacheCounter.count + " gpt cache hits.");

} catch (error) {
	console.error('Unhandled error:', error);
} finally {
  if (chromeFetcher) {
    await chromeFetcher.destroy();
    chromeFetcher = null;
  }
  db.destroy();
}

// Handle SIGINT signal
process.on('SIGINT', async () => {
  if (chromeFetcher) {
    console.log("Caught SIGINT, killing fetcher process...");
    await chromeFetcher.destroy();
    chromeFetcher = null;
    console.log("Killed fetcher process.");
  }
});

// console.log("Handles:");
// console.log(process._getActiveHandles());
// console.log("Requests:");
// console.log(process._getActiveRequests());
console.log("Done!");
