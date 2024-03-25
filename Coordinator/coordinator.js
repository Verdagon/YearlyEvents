// challenges, competitions, festivals, events, celebrations

import syncFs from "fs";
import http from "http";
import https from "https";
import util from 'node:util';
import { execFile } from 'node:child_process'
import { delay } from "../Common/parallel.js";
import { LocalDb } from '../LocalDB/localdb.js'
// import { getUnanalyzedSubmissions } from '../getUnanalyzedSubmissions.js'
import { analyzePage } from './analyze.js'
import { addSubmission } from '../Common/addSubmission.js'
import fs from "fs/promises";
import { Configuration, OpenAIApi } from "openai";
import { Semaphore, parallelEachI, makeMsThrottler } from "../Common/parallel.js";
import { normalizeName } from "../Common/utils.js";
import urlencode from 'urlencode';

function onlyUnique(value, index, array) {
  return array.indexOf(value) === index;
}
function distinct(a) {
	return a.filter(onlyUnique);
}

// Function to fetch PDF from URL and save it to a file
function fetchPDF(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = syncFs.createWriteStream(filePath);

        if (url.startsWith("https://")) {
	        https.get(url, response => {
	            response.pipe(file);
	            file.on('finish', () => {
	                file.close(resolve);
	            });
	        }).on('error', error => {
	            fs.unlink(filePath, () => reject(error));
	        });
	    } else {
	    	http.get(url, response => {
	            response.pipe(file);
	            file.on('finish', () => {
	                file.close(resolve);
	            });
	        }).on('error', error => {
	            fs.unlink(filePath, () => reject(error));
	        });
	    }
    });
}


async function runCommandForStatus(program, args) {
	try {
		// Seems to return an object with just two fields, like:
		// { stdout: 'Success!\n', stderr: '' }
		await execFileAsync(program, args);
		return 0;
	} catch (e) {
		console.log("Command failed: ", program, args);
		console.log("exitCode:\n" + e.exitCode);
		console.log("stdout:\n" + e.stdout);
		console.log("stderr:\n" + e.stderr);
		return e.exitCode;
	}
}

async function runCommandForNullableStdout(program, args) {
	try {
		const result = await execFileAsync(program, args);
		const { stdout } = result;
		if (typeof stdout != "string") {
			console.log("wat: ", result)
		}
		return stdout;
	} catch (e) {
		console.log("Command failed: ", program, args);
		console.log("stdout:\n" + e.stdout);
		console.log("stderr:\n" + e.stderr);
		return null;
	}
}

async function retry(n, func, numAttempts) {
	numAttempts = numAttempts || 0;
	try {
		return await func();
	} catch (e) {
		if (numAttempts < 3) {
			console.log("Retrying after failed first attempt:", e);
			return await retry(n, func, numAttempts + 1);
		} else {
			console.log("Failed after three retries, aborting.");
			throw e;
		}
	}
}

async function addOtherEventSubmission(db, otherEvent) {
	const {url, analysis: {name, city, state, yearly, summary}} = otherEvent;
	console.log("Other event: " + name + " in " + city + ", " + state + ", " + (yearly ? "yearly" : "(unsure if yearly)") + " summary: " + summary);
	return await addSubmission(db, {name, city, state, description: summary, url}, false);
}

async function getPageText(scratchDir, db, chromeThrottler, chromeCacheCounter, throttlerPriority, steps, eventI, eventName, resultI, url) {
	// This used to be wrapped in a transaction but I think it was causing the connection
	// pool to get exhausted.

	const cachedPageTextRow =
			await db.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
	if (cachedPageTextRow) {
		chromeCacheCounter.count++;
		return cachedPageTextRow;
	}

	console.log("Asking for browse to " + url);
	steps.push("Browsing to " + url);
	const pdf_path = scratchDir + "/result" + eventI + "-" + resultI + ".pdf"
	const fetcher_result =
			url.endsWith(".pdf") ?
					await fetchPDF(url, pdf_path) :
					await retry(3, async () => {
						return await chromeThrottler.prioritized(throttlerPriority, async () => {
							console.log("Released for Chrome!", throttlerPriority)
							console.log("Attempting browse to " + url);
							return await runCommandForNullableStdout(
									"./PageFetcher/target/debug/PageFetcher", [url, pdf_path]);
						});
					});
	if (!fetcher_result) {
		const error = "Bad fetch/browse for event " + eventName + " result " + url;
		console.log(error)
		await db.cachePageText({url, text: null, error});
		return {text: null, error};
	}

	const txt_path = scratchDir + "/" + url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
	const pdftotextExitCode =
		  await runCommandForStatus(
		  		"/opt/homebrew/bin/python3", ["./PdfToText/main.py", pdf_path, txt_path])
	console.log("Ran PDF-to-text, exit code:", pdftotextExitCode)
	if (pdftotextExitCode !== 0) {
		const error = "Bad PDF-to-text for event " + eventName + " at url " + url + " pdf path " + pdf_path;
		console.log(error);
		await db.cachePageText({url, text: null, error});
		return {text: null, error};
	}
	steps.push("Created text in " + txt_path)
	const text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
	if (!text) {
		const error = "No result text found for " + eventName + " at url " + url;
		console.log(error);
		await db.cachePageText({url, text: null, error});
		return {text: null, error};
	}


	await db.transaction(async (trx) => {
		const cachedPageTextRow =
				await trx.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
		if (!cachedPageTextRow) {
			await trx.cachePageText({url, text, error: null});
		}
	});
	return {text, error: null};
}

async function googleSearch(googleSearchApiKey, query) {
	try {
		const url =
				"https://www.googleapis.com/customsearch/v1?key=" + googleSearchApiKey +
				"&cx=8710d4180bdfd4ba9&q=" + urlencode(query);
		const response = await fetch(url);
		if (!response.ok) {
      throw response;
    }
    const body = await response.json();
		if (!body.items) {
			throw "Bad response error: " + body;
		}
		if (!body.items.length) {
			throw "Bad response error: " + body;
		}
		return body.items.slice(0, 7).map(x => x.link);
	} catch (error) {
    if (typeof error.json === "function") {
    	const jsonError = await error.json();
    	throw jsonError;
    } else {
      throw "Generic error from API: " + error + ": " + JSON.stringify(error);
    }
	}
}

async function getSearchResult(db, googleSearchApiKey, searchThrottler, searchCacheCounter, throttlerPriority, googleQuery) {
	const maybeSearcherResult =
			await db.getFromDb("GoogleCache", searchCacheCounter, {"query": googleQuery}, ["response"]);
	if (maybeSearcherResult) {
		const {response} = maybeSearcherResult;
		console.log({response});
		return {response};
	}
	const response =
			await searchThrottler.prioritized(throttlerPriority, async () => {
				console.log("Released for Google!", throttlerPriority)
				return await googleSearch(googleSearchApiKey, googleQuery);
			});
	await db.cacheGoogleResult({query: googleQuery, response: response});
	console.log({response: response});
	return {response: response};
}

async function investigate(scratchDir, db, googleSearchApiKey, searchThrottler, searchCacheCounter, chromeThrottler, chromeCacheCounter, gptThrottler, throttlerPriority, gptCacheCounter, otherEvents, event_i, event_name, event_city, event_state, maybeUrl) {
	const broadSteps = [];
	const googleQuery = event_name + " " + event_city + " " + event_state;
	console.log("Googling: " + googleQuery);
	broadSteps.push("Googling: " + googleQuery);
	const searcherResult = await getSearchResult(db, googleSearchApiKey, searchThrottler, searchCacheCounter, throttlerPriority, googleQuery);
	if (searcherResult == null) {
		console.log("Bad search for event " + event_name)
		broadSteps.push("Bad search for event " + event_name);
		const result = {
			confirms: [],
			rejects: [],
			month: "",
			num_errors: 1,
			num_promising: 0,
			name: event_name,
			city: event_city,
			state: event_state
		};
		return result;
	}
	const response = searcherResult.response;

	if (maybeUrl) {
		if (!response.includes(maybeUrl)) {
			response.unshift(maybeUrl);
		}
	}

	const confirms = []
	const rejects = []
	let num_promising = 0
	let num_errors = 0


	// Order them by shortest first, shorter URLs tend to be more canonical
	response.sort((a, b) => a.length - b.length);

	// We dont parallelize this loop because we want it to early-exit if it finds
	// enough to confirm.
	for (const [search_result_i, search_result_url] of response.entries()) {
		const pageSteps = [];

		console.log("Considering", search_result_url);
		pageSteps.push("Considering " + search_result_url);
		broadSteps.push("Considering " + search_result_url);

		if (search_result_url == "") {
			console.log("Skipping blank url");
			pageSteps.push("Skipping blank url");
			broadSteps.push("Skipping blank url");
			continue
		}
		if (search_result_url.includes("youtube.com")) {
			console.log("Skipping blacklisted domain");
			pageSteps.push("Skipping blacklisted domain");
			broadSteps.push("Skipping blacklisted domain");
			continue
		}
		if (search_result_url.includes("twitter.com")) {
			console.log("Skipping blacklisted domain");
			pageSteps.push("Skipping blacklisted domain");
			broadSteps.push("Skipping blacklisted domain");
			continue
		}

		const {text: pageText, error: pageTextError} =
				await getPageText(
						scratchDir, db, chromeThrottler, chromeCacheCounter, throttlerPriority, pageSteps, event_i, event_name, search_result_i, search_result_url);
		if (!pageText) {
			console.log("No page text, skipping.");
			pageSteps.push("No page text, skipping.");
			broadSteps.push("No page text, skipping.");
			num_errors++;

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: null,
				steps: pageSteps
			});

			continue;
		}

		pageSteps.push("Analyzing page...");
		const [matchness, analysis] =
			await analyzePage(
				db, gptCacheCounter, gptThrottler, throttlerPriority, pageSteps, openai, search_result_url, pageText, event_name, event_city, event_state);

		if (matchness == 5) { // Multiple events
			console.log("Multiple events, ignoring.");
			pageSteps.push("Multiple events, ignoring.");
			broadSteps.push("Multiple events, ignoring.");

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: analysis,
				steps: pageSteps
			});
		} else if (matchness == 4) { // Same city, confirmed.
			console.log(event_name + " confirmed by " + search_result_url)
			pageSteps.push(event_name + " confirmed by " + search_result_url);
			broadSteps.push(event_name + " confirmed by " + search_result_url);

			const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;
			const promising = yearly || (nextDate != null)
			if (promising) {
				num_promising++;
			}

			confirms.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				analysis: analysis,
				month: month,
				steps: pageSteps
			});

			if (confirms.length + num_promising >= 5) {
				console.log("Found enough confirming " + event_name + ", continuing!");
				pageSteps.push("Found enough confirming " + event_name + ", continuing!");
				broadSteps.push("Found enough confirming " + event_name + ", continuing!");
				break;
			}
		} else if (matchness == 3) { // Same state, not quite confirm, submit it to otherEvents
			const success =
					await addOtherEventSubmission(db, { url: search_result_url, pageText, analysis: analysis });
			if (!success) {
				console.log("Rediscovered:", analysis.name);
				pageSteps.push("Rediscovered:" + analysis.name);
				broadSteps.push("Rediscovered:" + analysis.name);
			}

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: analysis,
				steps: pageSteps
			});
		} else if (matchness == 2) { // Same event but not even in same state, submit it to otherEvents
			const success =
					await addOtherEventSubmission(db, { url: search_result_url, pageText, analysis: analysis });
			if (!success) {
				console.log("Rediscovered:", analysis.name);
				pageSteps.push("Rediscovered:" + analysis.name);
				broadSteps.push("Rediscovered:" + analysis.name);
			}

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: analysis,
				steps: pageSteps
			});
		} else if (matchness == 1) { // Not same event, ignore it.
			console.log("Not same event at all, ignoring.");
			pageSteps.push("Not same event at all, ignoring.");
			broadSteps.push("Not same event at all, ignoring.");

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: analysis,
				steps: pageSteps
			});
		} else if (matchness == 0) { // Not an event, skip
			console.log("Not an event, skipping.")
			pageSteps.push("Not an event, skipping.");
			broadSteps.push("Not an event, skipping.");

			rejects.push({
				url: search_result_url,
				pageSteps: pageSteps,
				pageText,
				pageTextError,
				analysis: analysis,
				steps: pageSteps
			});
		} else {
			console.log("Wat response:", matchness, analysis);
			pageSteps.push("Wat response: " + matchness + " " + JSON.stringify(analysis));
			broadSteps.push("Wat response: " + matchness + " " + JSON.stringify(analysis));
			num_errors++;
		}
	}

	let months = [];
	for (const {url, month, promising} of confirms) {
		if (month) {
			months.push(month);
		}
	}
	months = distinct(months);
	const month = months.length == 1 ? months[0] : "";

	const investigation = {
		confirms: confirms,
		rejects: rejects,
		month: month,
		num_errors: num_errors,
		num_promising: num_promising,
		name: event_name,
		city: event_city,
		state: event_state,
		broad_steps: broadSteps
	};
	return investigation;
}

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
	const chromeThrottler = new Semaphore(5, null);
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
		steps.push("Starting doublecheck for event " + eventName + " in " + eventCity + ", " + eventState);

		const investigation =
			await investigate(
				scratchDir,
				db,
				googleSearchApiKey,
				searchThrottler,
				searchCacheCounter,
				chromeThrottler,
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
			console.log("Doublecheck failed for \"" + eventName + "\" in " + eventCity + ", " + eventState);
			steps.push("Doublecheck null so failed for \"" + eventName + "\" in " + eventCity + ", " + eventState);
			investigation = {confirms: [], found_month: "", num_errors: 1, num_promising: 0};
		}

		const {confirms, rejects, found_month: foundMonth, num_errors, num_promising} = investigation;
		
		await db.transaction(async (trx) => {
			if (confirms.length == 0) {
				if (num_errors > 0) {
					console.log("Concluded ERRORS for " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + ")");
					steps.push("Concluded ERRORS for " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + ")");

					trx.updateSubmissionStatus(submissionId, 'errors', null, investigation, steps);
				} else {
					console.log("Concluded HALLUCINATED " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + ")");
					steps.push("Concluded HALLUCINATED " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + ")");

					trx.updateSubmissionStatus(submissionId, 'failed', null, investigation, steps);
				}
			} else {
				console.log("Concluded FOUND " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + "), see:");
				steps.push("Concluded FOUND " + eventName + " in " + eventCity + ", " + eventState + " (" + submissionIndex + ").");
				for (const confirm of confirms) {
					console.log("    " + confirm.url);
				}
				const eventId = crypto.randomUUID();
				trx.updateSubmissionStatus(submissionId, 'confirmed', eventId, investigation, steps);
				await trx.insertEvent({
					id: eventId,
					submission_id: submissionId,
		    	name: eventName,
		    	city: eventCity,
		    	state: eventState,
		    	month_number: foundMonth,
		    	status: "analyzed"
		    });
		    for (const {url, steps, pageText, pageLongSummary, analysis, month} of confirms) {
					await trx.insertConfirmation({
						id: crypto.randomUUID(),
						event_id: eventId,
						url,
						page_text: pageText,
						page_long_summary: analysis.description,
						event_short_summary: analysis.summary
			    });
		    }
			}
		});
	});

	console.log("");
	console.log(searchCacheCounter.count + " search cache hits.");
	console.log(chromeCacheCounter.count + " fetch cache hits.");
	console.log(gptCacheCounter.count + " gpt cache hits.");
} catch (error) {
	console.error('Unhandled promise rejection:', error);
	process.exit(1);
}

db.destroy();
console.log("Done!")
