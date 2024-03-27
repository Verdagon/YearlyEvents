// challenges, competitions, festivals, events, celebrations

import syncFs from "fs";
import http from "http";
import https from "https";
import util from 'node:util';
import { execFile, spawn } from 'node:child_process'
import { delay } from "../Common/parallel.js";
import { LocalDb } from '../LocalDB/localdb.js'
// import { getUnanalyzedSubmissions } from '../getUnanalyzedSubmissions.js'
import { addSubmission } from '../Common/addSubmission.js'
import fs from "fs/promises";
import { logs, normalizeName, makeLineServerProcess } from "../Common/utils.js";
import { investigate } from "./investigate.js";
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

const db = new LocalDb(null, "./db.sqlite");

let chromeFetcher = null;
try {
	const gptThrottler = new Semaphore(null, 120);
	const searchThrottler = new Semaphore(10, null);
	chromeFetcher =
			await makeLineServerProcess(
					'./PageFetcher/target/debug/page_fetcher', [], 'Ready');
	const chromeCacheCounter = { count: 0 };
	const searchCacheCounter = { count: 0 };
	const gptCacheCounter = { count: 0 };


	const otherEvents = [];
	let approvedSubmissions = (await db.getApprovedSubmissions());
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

		console.log("Starting doublecheck for event " + eventName + " in " + eventCity + ", " + eventState);

    const model = 'gpt-3.5-turbo';

    // This will update things in the database
		await investigate(
        openai,
				scratchDir,
				db,
				googleSearchApiKey,
				searchThrottler,
				searchCacheCounter,
				chromeFetcher,
				chromeCacheCounter,
				gptThrottler,
				throttlerPriority,
				gptCacheCounter,
				otherEvents,
				submissionIndex,
				eventName,
				eventCity,
				eventState,
				maybeUrl,
        submissionId,
        model)
		
    const investigationRow = await db.getInvestigation(submissionId, model);
    const pageAnalysesRows = await db.getInvestigationPageAnalyses(submissionId, model);

    if (investigationRow.status == 'created') {
      // Continue on, this one's paused on some external thing.
      logs()("Concluded nothing yet for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");
      return;
    } else if (investigationRow.status == 'failed') {
      await db.updateSubmissionStatus(submissionId, 'failed');
      logs()("Concluded failed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");

    } else if (investigationRow == 'confirmed') {
      logs()("Concluded confirmed for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");

      await db.transaction(async (trx) => {
        await trx.updateSubmissionStatus(submissionId, 'confirmed');

        const eventId = crypto.randomUUID();
        await trx.insertEvent({
          id: eventId,
          submission_id: submissionId,
          name: eventName,
          city: eventCity,
          state: eventState,
          month_number: unanimousMonth,
          status: "created"
        });
        await parallelEachI(
            pageAnalyses,
            async ({status, url, steps, pageText, pageLongSummary, analysis, month}) => {
              if (status == 'confirmed') {
                await trx.insertConfirmation({
                  id: crypto.randomUUID(),
                  event_id: eventId,
                  url,
                  page_text: pageText,
                  page_long_summary: analysis.description,
                  event_short_summary: analysis.summary
                });
              }
            });
      });
    }
	});

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

console.log("Done!");
