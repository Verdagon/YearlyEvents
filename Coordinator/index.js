// challenges, competitions, festivals, events, celebrations

import http from "http";
import https from "https";
import util from 'node:util';
import { execFile } from 'node:child_process'
import { delay } from "../parallel.js";
import { connectKnex, dbCachedZ, getFromDb } from '../db.js'
// import { getUnanalyzedSubmissions } from '../getUnanalyzedSubmissions.js'
import { analyzePage } from './analyze.js'
import { addSubmission } from '../addSubmission.js'
import fs from "fs/promises";
import rawfs from "fs";
import { Configuration, OpenAIApi } from "openai";
import { Semaphore, parallelEachI, makeMsThrottler } from "../parallel.js";
import { normalizeName } from "../utils.js";

function onlyUnique(value, index, array) {
  return array.indexOf(value) === index;
}
function distinct(a) {
	return a.filter(onlyUnique);
}

// Function to fetch PDF from URL and save it to a file
function fetchPDF(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = rawfs.createWriteStream(filePath);

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

async function addOtherEventSubmission(knex, otherEvent) {
	const {url, analysis: {name, city, state, yearly, summary}} = otherEvent;
	console.log("Other event: " + name + " in " + city + ", " + state + ", " + (yearly ? "yearly" : "(unsure if yearly)") + " summary: " + summary);
	return await addSubmission(knex, {name, city, state, description: summary, url}, false);
}

async function getPageText(knex, chromeThrottler, chromeCacheCounter, throttlerPriority, steps, eventI, eventName, resultI, url) {
	return await knex.transaction(async (trx) => {
		const cachedPageTextRow =
				await getFromDb(
						trx, "PageTextCache", chromeCacheCounter, {"url": url});
		if (cachedPageTextRow) {
			chromeCacheCounter.count++;
			return cachedPageTextRow;
		}

		console.log("Asking for browse to " + url);
		steps.push("Browsing to " + url);
		const pdf_path = "temp/result" + eventI + "-" + resultI + ".pdf"
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
			await trx.into("PageTextCache").insert({url, text: null, error});
			return {text: null, error};
		}

		const txt_path = "pagetexts/" + url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
		const pdftotext_result =
			  await runCommandForStatus(
			  		"/opt/homebrew/bin/python3", ["./PdfToText/main.py", pdf_path, txt_path])
		if (pdftotext_result != 0) {
			const error = "Bad PDF-to-text for event " + eventName + " at url " + url + " pdf path " + pdf_path;
			console.log(error);
			await trx.into("PageTextCache").insert({url, text: null, error});
			return {text: null, error};
		}
		steps.push("Created text in " + txt_path)
		const text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
		if (!text) {
			const error = "No result text found for " + eventName + " at url " + url;
			console.log(error);
			await trx.into("PageTextCache").insert({url, text: null, error});
			return {text: null, error};
		}

		await trx.into("PageTextCache").insert({url, text, error: null});
		return {text, error: null};
	});
}

async function doublecheck(knex, googleSearchApiKey, searchThrottler, searchCacheCounter, chromeThrottler, chromeCacheCounter, gptThrottler, throttlerPriority, gptCacheCounter, otherEvents, event_i, event_name, event_city, event_state, maybeUrl, steps) {
	const googleQuery = event_name + " " + event_city + " " + event_state;
	console.log("Googling: " + googleQuery);
	const searcherResult =
			await dbCachedZ(
					knex,
					"GoogleCache",
					searchCacheCounter,
					{"query": googleQuery},
					async () => {
						return await searchThrottler.prioritized(throttlerPriority, async () => {
							console.log("Released for Google!", throttlerPriority)
							const unsplitResult =
							    await runCommandForNullableStdout(
									"node",
									["./Searcher/index.js", googleSearchApiKey, googleQuery]);
							const response = unsplitResult && unsplitResult.split("\n");
							return {response};
						});
					},
					async (response) => response, // transform
					response => !!response, // cacheIf
					["response"]);
	if (searcherResult == null) {
		console.log("Bad search for event " + event_name)
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


	// We dont parallelize this loop because we want it to early-exit if it finds
	// enough to confirm.
	for (const [search_result_i, search_result_url] of response.entries()) {
		if (search_result_url == "") {
			continue
		}
		console.log("Considering", search_result_url);
		steps.push("Considering " + search_result_url);
		if (search_result_url.includes("youtube.com")) {
			steps.push("Skipping blacklisted domain");
			continue
		}
		if (search_result_url.includes("twitter.com")) {
			steps.push("Skipping blacklisted domain");
			continue
		}

		const {text: pageText, error: pageTextError} =
				await getPageText(
						knex, chromeThrottler, chromeCacheCounter, throttlerPriority, steps, event_i, event_name, search_result_i, search_result_url);
		if (!pageText) {
			console.log("No page text, skipping.");
			steps.push("No page text, skipping.");
			num_errors++;
			continue;
		}

		const [matchness, analysis] =
			await analyzePage(
				knex, gptCacheCounter, gptThrottler, throttlerPriority, steps, openai, search_result_url, pageText, event_name, event_city, event_state);

		if (matchness == 5) { // Multiple events
			// Do nothing
		} else if (matchness == 4) { // Same city, confirmed.
			console.log(event_name + " confirmed by " + search_result_url)
			steps.push(event_name + " confirmed by " + search_result_url);

			const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;
			const promising = yearly || (nextDate != null)
			if (promising) {
				num_promising++;
			}

			confirms.push({ url: search_result_url, steps: steps, pageText, analysis: analysis, month: month });

			if (confirms.length + num_promising >= 4) {
				console.log("Found enough confirming " + event_name + ", continuing!");
				steps.push("Found enough confirming " + event_name + ", continuing!");
				break;
			}
		} else if (matchness == 3) { // Same state, not quite confirm, submit it to otherEvents
			const success =
					await addOtherEventSubmission(knex, { url: search_result_url, pageText, analysis: analysis });
			if (!success) {
				console.log("Rediscovered:", analysis.name);
			}
		} else if (matchness == 2) { // Same event but not even in same state, submit it to otherEvents
			const success =
					await addOtherEventSubmission(knex, { url: search_result_url, pageText, analysis: analysis });
			if (!success) {
				console.log("Rediscovered:", analysis.name);
				steps.push("Rediscovered:" + analysis.name);
			}
		} else if (matchness == 1) { // Not same event, ignore it.
			// Do nothing
		} else if (matchness == 0) { // Not an event, skip
			console.log("Not an event, skipping.")
			steps.push("Not an event, skipping.");
			// Not a match at all
			continue;
		} else {
			console.log("Wat response:", matchness, analysis);
			steps.push("Wat response: " + matchness + " " + JSON.stringify(analysis));
			num_errors++;
			continue;
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

	const result = {
		confirms: confirms,
		rejects: rejects,
		month: month,
		num_errors: num_errors,
		num_promising: num_promising,
		name: event_name,
		city: event_city,
		state: event_state
	};
	return result;
}

const execFileAsync = util.promisify(execFile);

const openAiApiKey = process.argv[2]
if (openAiApiKey == "") {
	console.log("Please enter the OpenAI key for the first argument.")
	console.log("Example usage:")
	console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 true \"North Carolina\" \"What are the 3 weirdest yearly championships that happen in North Carolina?\"")
	process.exit(1)
}

const googleSearchApiKey = process.argv[3]
if (googleSearchApiKey == "") {
	console.log("Please enter the Google Search API key for the second argument.")
	console.log("Example usage:")
	console.log("    node index.js openAIKeyHere123 googleSearchKeyHere456 true \"North Carolina\" \"What are the 3 weirdest yearly championships that happen in North Carolina?\"")
	process.exit(1)
}

const configuration =
		new Configuration({
		    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		    apiKey: openAiApiKey,
		});
const openai = new OpenAIApi(configuration);

const knex = connectKnex("./db.sqlite");

try {
	const gptThrottler = new Semaphore(null, 120);
	const searchThrottler = new Semaphore(10, null);
	const chromeThrottler = new Semaphore(10, null);
	const chromeCacheCounter = { count: 0 };
	const searchCacheCounter = { count: 0 };
	const gptCacheCounter = { count: 0 };


	const otherEvents = [];
	const approvedSubmissions =
			await knex.select().from("Submissions")
		      .whereNotNull("name")
		      .whereNotNull("state")
		      .whereNotNull("city")
		      .where({status: 'approved'});

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

		const doublecheckResult =
			await doublecheck(
				knex,
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

		if (!doublecheckResult) {
			console.log("Doublecheck failed for \"" + eventName + "\" in " + eventCity + ", " + eventState);
			steps.push("Doublecheck null so failed for \"" + eventName + "\" in " + eventCity + ", " + eventState);
			doublecheckResult = {confirms: [], found_month: "", num_errors: 1, num_promising: 0};
		}

		const {confirms, rejects, found_month: foundMonth, num_errors, num_promising} = doublecheckResult;
		
		await knex.transaction(async (trx) => {
			if (confirms.length == 0) {
				if (num_errors > 0) {
					console.log("Concluded ERRORS for " + eventName + " in " + eventCity + " (" + submissionIndex + ")");
					steps.push("Concluded ERRORS for " + eventName + " in " + eventCity + " (" + submissionIndex + ")");

					await trx("Submissions").where({'submission_id': submissionId})
							.update({
								status: 'errors',
								analysis: JSON.stringify(doublecheckResult),
								steps: JSON.stringify(steps)
							});
				} else {
					console.log("Concluded HALLUCINATED " + eventName + " in " + eventCity + " (" + submissionIndex + ")");
					steps.push("Concluded HALLUCINATED " + eventName + " in " + eventCity + " (" + submissionIndex + ")");

					await trx("Submissions").where({'submission_id': submissionId})
							.update({
								status: 'failed',
								analysis: JSON.stringify(doublecheckResult),
								steps: JSON.stringify(steps)
							});
				}
			} else {
				console.log("Concluded FOUND " + eventName + " in " + eventCity + " (" + submissionIndex + "), see:");
				steps.push("Concluded FOUND " + eventName + " in " + eventCity + " (" + submissionIndex + ").");
				for (const confirm of confirms) {
					console.log("    " + confirm.url);
				}
				const eventId = crypto.randomUUID();
				await trx("Submissions").where({'submission_id': submissionId})
						.update({
							status: 'confirmed',
							event_id: eventId,
							analysis: JSON.stringify(doublecheckResult),
							steps: JSON.stringify(steps)
						});
				await trx.into("ConfirmedEvents").insert({
					id: eventId,
					submission_id: submissionId,
		    	name: eventName,
		    	city: eventCity,
		    	state: eventState,
		    	month_number: foundMonth,
		    	status: "analyzed"
		    });
		    for (const {url, steps, pageText, pageLongSummary, analysis, month} of confirms) {
					await trx.into("EventConfirmations").insert({
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

knex.destroy();
console.log("Done!")
