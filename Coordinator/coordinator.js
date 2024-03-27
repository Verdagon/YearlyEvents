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

const execFileAsync = util.promisify(execFile);

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




const configuration =
		new Configuration({
		    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		    apiKey: openAiApiKey,
		});
const openai = new OpenAIApi(configuration);

const db = new LocalDb(null, "./db.sqlite");

try {
	const gptThrottler = new Semaphore(null, 120);
	const searchThrottler = new Semaphore(10, null);
	const chromeFetcher =
			await makeLineServerProcess(
					'./PageFetcher/target/debug/page_fetcher', [], 'Ready');
	const chromeCacheCounter = { count: 0 };
	const searchCacheCounter = { count: 0 };
	const gptCacheCounter = { count: 0 };


	const otherEvents = [];
	const approvedSubmissions = await db.getApprovedSubmissions();

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

		const steps = [];
		logs(steps)("Starting doublecheck for event " + eventName + " in " + eventCity + ", " + eventState);

		const investigation =
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
				steps)

		if (!investigation) {
			logs(steps)("Doublecheck failed for", eventName, "in", eventCity, eventState);
			investigation = {pageAnalyses: [], broad_steps: [], found_month: "", num_errors: 1, num_promising: 0};
		}

		const {pageAnalyses, found_month: foundMonth, num_errors, num_promising, broad_steps: broadSteps} = investigation;
		
		await db.transaction(async (trx) => {
      const numConfirms = pageAnalyses.filter(x => x.status == 'confirmed').length;
      const status =
          (numConfirms ? "confirmed" : (num_errors > 0 ? "errors" : "hallucinated"));
      logs(steps)("Concluded", status, "for", eventName, "in", eventCity, eventState, "(" + submissionIndex + ")");
      for (const analysis of pageAnalyses) {
        if (analysis.status == 'confirmed') {
          console.log("    " + analysis.url);
        }
      }

      await trx.updateSubmissionStatus(submissionId, status);
      await trx.addInvestigation(
          submissionId, 'gpt-3.5-turbo', status, investigation, broadSteps, pageAnalyses);

			if (numConfirms) {
        const eventId = crypto.randomUUID();

				await trx.insertEvent({
					id: eventId,
					submission_id: submissionId,
		    	name: eventName,
		    	city: eventCity,
		    	state: eventState,
		    	month_number: foundMonth,
		    	status: "analyzed"
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
			}
		});
	});

	console.log("");
	console.log(searchCacheCounter.count + " search cache hits.");
	console.log(chromeCacheCounter.count + " fetch cache hits.");
	console.log(gptCacheCounter.count + " gpt cache hits.");

	await chromeFetcher.destroy();
	db.destroy();
	console.log("Done!")
} catch (error) {
	console.error('Unhandled promise rejection:', error);
	process.exit(1);
}
