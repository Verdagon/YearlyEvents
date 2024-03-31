// challenges, competitions, festivals, events, celebrations

import syncFs from "fs";
import http from "http";
import https from "https";
import util from 'node:util';
import { ChatGPTRequester } from "../Common/chatgptrequester.js";
import { execFile, spawn } from 'node:child_process'
import { delay } from "../Common/parallel.js";
import { LocalDb } from '../LocalDB/localdb.js'
// import { getUnanalyzedSubmissions } from '../getUnanalyzedSubmissions.js'
import { addSubmission } from '../Common/addSubmission.js'
import fs from "fs/promises";
import { logs, deloggify, normalizeName, makeLineServerProcess } from "../Common/utils.js";
import { investigate } from "./investigate.js";
import { analyzePageOuter, analyzeMatchOuter } from './analyze.js'
import { Configuration, OpenAIApi } from "openai";
import { Semaphore, parallelEachI, makeMsThrottler } from "../Common/parallel.js";
import urlencode from 'urlencode';

const openAiApiKey = process.argv[2]
if (!openAiApiKey) {
	console.log("Please enter the OpenAI key for the first argument.")
	console.log("Example usage:")
	console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 scratch");
	process.exit(1)
}

const googleSearchApiKey = process.argv[3]
if (!googleSearchApiKey) {
	console.log("Please enter the Google Search API key for the second argument.")
	console.log("Example usage:")
	console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 scratch");
	process.exit(1)
}

const scratchDir = process.argv[4]
if (!scratchDir) {
	console.log("Please enter the scratch dir for the third argument.")
	console.log("Example usage:")
	console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 scratch");
	process.exit(1)
}
if (!syncFs.existsSync(scratchDir)) {
	console.log("Making scratch dir:", scratchDir);
  syncFs.mkdirSync(scratchDir);
}

const filterSubmissionId = process.argv[5] || null;



const configuration =
		new Configuration({
		    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		    apiKey: openAiApiKey,
		});
const openai = new OpenAIApi(configuration);

const fetchThrottler = new Semaphore(10, null);
const searchThrottler = new Semaphore(10, null);
const dbThrottler = new Semaphore(1, null);

const llmRequester = new ChatGPTRequester(openai);

const db = new LocalDb(dbThrottler, null, "./db.sqlite");

let chromeFetcher = null;
try {
	chromeFetcher =
			await makeLineServerProcess(
					'./PageFetcher/target/debug/page_fetcher', [], 'Ready');
	const chromeCacheCounter = { count: 0 };
	const searchCacheCounter = { count: 0 };
	const gptCacheCounter = { count: 0 };

  const model = 'gpt-3.5-turbo';

  let unfinishedLeads = await db.getUnfinishedLeads();
  console.log(unfinishedLeads.length, "unfinished leads.");
  await parallelEachI(unfinishedLeads, async (leadIndex, lead) => {
    let broadSteps = lead.steps;
    await analyzePageOuter(
        openai,
        scratchDir,
        db,
        googleSearchApiKey,
        fetchThrottler,
        searchThrottler,
        searchCacheCounter,
        chromeFetcher,
        chromeCacheCounter,
        llmRequester,
        -leadIndex, // throttlerPriority
        gptCacheCounter,
        model,
        "Lead" + leadIndex,
        null,
        null,
        null,
        lead.id,
        broadSteps,
        0, // search_result_i
        lead.url);

    const pageAnalysisRow =
        await db.getPageAnalysis(lead.url, model);
    if (pageAnalysisRow.status == 'created') {
      console.log("Lead analysis row is status created, pausing investigation.");
      // If it's still created status, then we're waiting on something external.
      return;
    } else if (pageAnalysisRow.status == 'success') {
      // proceed
    } else if (pageAnalysisRow.status == 'errors') {
      logs(broadSteps)("Analysis for", lead.url, "had errors, marking lead.");
      await db.updateLead(lead.id, 'errors', broadSteps);
      return;
    } else if (pageAnalysisRow.status == 'rejected') {
      logs(broadSteps)("Analysis for", lead.url, "rejected, marking lead.");
      await db.updateLead(lead.id, 'rejected', broadSteps);
      return;
    } else {
      throw "Weird status from analyze: " + pageAnalysisRow.status;
    }

    logs(broadSteps)("Lead url", lead.url, "success, adding", lead.status, "submission.");

    const existingId =
        await addSubmission(db, {
            submission_id: lead.id,
            status: lead.future_submission_status == 'approved' ? 'approved' : 'created',
            name: pageAnalysisRow.analysis.name,
            city: pageAnalysisRow.analysis.city,
            state: pageAnalysisRow.analysis.state,
            description: pageAnalysisRow.analysis.summary,
            url: lead.url,
            origin_query: null,
            need: lead.future_submission_need
        });
    if (existingId != lead.id) {
      logs(broadSteps)("Lead already has a submission:", existingId);
    }

    lead.status = 'success'; // because its used below
    await db.updateLead(lead.id, 'success', broadSteps);
  });




	let approvedSubmissions = (await db.getApprovedSubmissionsOfNeed(2));
  if (filterSubmissionId - 0 == filterSubmissionId) {
    approvedSubmissions = approvedSubmissions.slice(0, filterSubmissionId - 0);
  } else if (filterSubmissionId) {
    approvedSubmissions = approvedSubmissions.filter(x => x.submission_id == filterSubmissionId);
  }


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
			url: maybeUrl
		} = submission;
		const eventName = normalizeName(originalEventName, eventCity, eventState);
		// Higher ones get prioritized more, and we want the earliest submissions prioritized more.
		const throttlerPriority = -submissionIndex;

		console.log("Starting doublecheck:", eventName, "in", eventCity, eventState, submissionId);

    // This will update things in the database
		await investigate(
        openai,
				scratchDir,
				db,
				googleSearchApiKey,
        fetchThrottler,
				searchThrottler,
				searchCacheCounter,
				chromeFetcher,
				chromeCacheCounter,
				llmRequester,
				throttlerPriority,
				gptCacheCounter,
				submissionIndex,
				eventName,
				eventCity,
				eventState,
				maybeUrl,
        submissionId,
        model)
		
    const investigationRow = await db.getInvestigation(submissionId, model);
    // const pageAnalysesRows = await db.getInvestigationPageAnalyses(submissionId, model);

    if (investigationRow.status == 'created') {
      // Continue on, this one's paused on some external thing.
      logs(outcomes)("Concluded nothing yet for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");
      return;
    } else if (investigationRow.status == 'failed') {
      await db.updateSubmissionStatus(submissionId, 'failed');
      logs(outcomes)("Concluded failed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");

    } else if (investigationRow.status == 'confirmed') {
      logs(outcomes)("Concluded confirmed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");

      await db.transaction(async (trx) => {
        await trx.updateSubmissionStatus(submissionId, 'confirmed');
      });
    } else if (investigationRow.status == 'errors') {
      logs(outcomes)("Concluded errors for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");
      await db.updateSubmissionStatus(submissionId, 'errors');
    } else {
      throw "Weird status from investigation: " + investigationRow.status;
    }
	});

  console.log("Outcomes:");
  for (const outcome of outcomes) {
    console.log("  " + deloggify(outcome));
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
