// challenges, competitions, festivals, events, celebrations

import util from 'node:util';
import { execFile } from 'node:child_process'
import { compareEvents, interrogatePage, analyzePage } from './compareEvents.js'
import fs from "fs/promises";
import { Configuration, OpenAIApi } from "openai";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function onlyUnique(value, index, array) {
  return array.indexOf(value) === index;
}
function distinct(a) {
	return a.filter(onlyUnique);
}

function unprependi(str, prefix, minLength) {
	if (str.toLowerCase().startsWith(prefix.toLowerCase())) {
		const result = str.substring(prefix.length);
		if (minLength != null) {
			if (result.length >= minLength) {
				return result;
			}
		} else {
			return result;
		}
	}
	return str;
}

function unprependiall(originalStr, prefixes, minLength) {
	for (let prefix of prefixes) {
		const newStr = unprependi(originalStr, prefix, minLength);
		if (newStr.length != originalStr.length) {
			return unprependiall(newStr, prefixes, minLength);
		}
	}
	return originalStr;
}

function normalizeName(name, city, state) {
	return unprependiall(
			name,
			[
				" ",
				".",
				"-",
				"international ",
				"national ",
				"annual ",
				"yearly ",
				"world ",
				"state ",
				"us ",
				"the ",
				city + " ",
				state + " ",
				city + "'s",
				state + "'s"
			],
			9);
}

// async function runCommand(program, args) {
// 	try {
// 		return await execFileAsync(program, args);
// 	} catch (e) {
// 		console.log("Command failed!");
// 		console.log("stdout:\n" + e.stdout);
// 		console.log("stderr:\n" + e.stderr);
// 		throw e;
// 	}
// }


async function tryThenElse(body, then, ellse) {
	let result;
	try {
		result = await body();
	} catch (e) {
		return await ellse(e);
	}
	return await then(result);
}

async function tryThen(body, then) {
	return await tryThenElse(body, then, async (e) => e);
}

async function tryElse(body, ellse) {
	return await tryThenElse(body, async (x) => x, ellse);
}


async function cached(cacheCounter, cacheToken, inner, transform, cacheIf) {
	const pathInCache = "cache/" + cacheToken + ".json";	
	try {
		const response = await fs.readFile(pathInCache, { encoding: 'utf8' });
		if (!response) {
			console.log("wat response:", response);
			process.exit(1);
		}
		let result = JSON.parse(response);
		result = transform(result);
		if (!result) {
			console.log("Not using result from cache.");
			throw null;
		}
		console.log("Reusing result from cache.");
		cacheCounter.count++;
		return result;
	} catch (readFileError) {
		const response = await inner();
		if (cacheIf(response)) {
			await fs.writeFile(pathInCache, JSON.stringify(response));
		}
		return response;
	}
}


async function runCommandForStatus(program, args) {
	try {
		await execFileAsync(program, args);
		return 0;
	} catch (e) {
		console.log("Command failed!");
		console.log("status:\n" + e.status);
		console.log("stdout:\n" + e.stdout);
		console.log("stderr:\n" + e.stderr);
		return e.status;
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
		console.log("Command failed!");
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

async function doublecheckInner(chromeThrottler, gptThrottler, otherEvents, event_i, event_name, event_city, event_state) {
	const google_query = event_name + " " + event_city + " " + event_state
	console.log("Googling: " + google_query)
	await gptThrottler();
	const searcher_result =
		await runCommandForNullableStdout("node", ["./Searcher/index.js", google_query])
	if (!searcher_result) {
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

	const search_result_urls = searcher_result.split("\n")

	const confirms = []
	const rejects = []
	let num_promising = 0
	let num_errors = 0

	for (const [search_result_i, search_result_url] of search_result_urls.entries()) {
		if (search_result_url == "") {
			continue
		}
		if (search_result_url.includes("youtube.com")) {
			continue
		}
		if (search_result_url.includes("twitter.com")) {
			continue
		}

		const steps = [];

		console.log("Asking for browse to " + search_result_url);
		steps.push("Browsing to " + search_result_url);
		const pdf_path = "temp/result" + event_i + "-" + search_result_i + ".pdf"
		const fetcher_result =
			await chromeThrottler.do(async () => {
				return await retry(3, async () => {
					console.log("Attempting browse to " + search_result_url);
					return await runCommandForNullableStdout(
							"./PageFetcher/target/debug/PageFetcher", [search_result_url, pdf_path]);
				});
			});
		if (!fetcher_result) {
			console.log("Bad fetch/browse for event " + event_name + " result " + search_result_url)
			num_errors++
			continue
		}

		const txt_path = "pagetexts/" + search_result_url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
		const pdftotext_result =
			await runCommandForStatus("/usr/bin/python3", ["./PdfToText/main.py", pdf_path, txt_path])
		if (pdftotext_result != 0) {
			console.log("Bad PDF-to-text for event " + event_name + " at url " + search_result_url)
			num_errors++
			continue
		}
		steps.push("Created text in " + txt_path)

		const page_text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
		if (page_text == "") {
			console.log("Empty page text, skipping.");
			num_errors++;
			continue;
		}

		const [matchness, analysis] =
			await analyzePage(gptThrottler, steps, openai, page_text, event_name, event_city, event_state);

		if (matchness == 0) {
			console.log("Not an event, skipping.")
			// Not a match at all
			continue;
		} else if (matchness == 5) {
			if (analysis) { // dunno if this condition is needed
				otherEvents.push({ url: search_result_url, pageText: page_text, analysis: analysis });
			}
		} else if (matchness < 5) {
			console.log(event_name + " confirmed by " + search_result_url + ":", analysis)

			const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;
			const promising = yearly || (nextDate != null)
			if (promising) {
				num_promising++;
			}

			confirms.push({ url: search_result_url, steps: steps, pageText: page_text, analysis: analysis, month: month });

			if (confirms.length + num_promising >= 4) {
				console.log("Found enough confirming " + event_name + ", continuing!");
				break;
			}
		} else {
			console.log("Wat response:", matchness, analysis);
			num_errors++;
			continue;
		}
	}

	if (confirms.length > 0) {
		console.log("Confirmed " + event_name + " in " + event_city + ":")
		let months = [];
		for (const {url, month, promising} of confirms) {
			console.log("  " + url);
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
	} else if (num_errors > 0) {
		console.log("Couldn't confirm event " + event_name + " in " + event_city + ", plus there were " + num_errors + " errors.")
		const result = {
			confirms: confirms,
			rejects: rejects,
			month: "",
			num_errors: num_errors,
			num_promising: num_promising,
			name: event_name,
			city: event_city,
			state: event_state
		};
		return result;
	} else {
		console.log("Couldn't confirm event " + event_name + " in " + event_city)
		const result = {
			confirms: confirms,
			rejects: rejects,
			month: "",
			num_errors: num_errors,
			num_promising: num_promising,
			name: event_name,
			city: event_city,
			state: event_state
		};
		return result;
	}
}

// Return null if we can't use it.
function readCachedObject(r) {
	if (!r) return null;
	if (r.num_errors === undefined) return null
	if (!Array.isArray(r.confirms)) return null
	if (!Array.isArray(r.rejects)) return null
	if (r.month === undefined) return null
	if (r.num_promising === undefined) return null
	if (r.name === undefined) return null
	if (r.city === undefined) return null
	if (r.state === undefined) return null

	for (const confirm of r.confirms) {
		if (confirm.url === undefined) return null
		if (!Array.isArray(confirm.steps)) return null
		if (confirm.pageText === undefined) return null
		if (confirm.analysis === undefined) return null

		if (confirm.analysis.yearly === undefined) return null;
		if (confirm.analysis.name === undefined) return null;
		if (confirm.analysis.city === undefined) return null;
		if (confirm.analysis.state === undefined) return null;
		if (confirm.analysis.month === undefined) return null;
		if (confirm.analysis.firstDate === undefined) return null;
		if (confirm.analysis.lastDate === undefined) return null;
		if (confirm.analysis.nextDate === undefined) return null;
		if (confirm.analysis.summary === undefined) return null;
		if (confirm.analysis.description === undefined) return null;
	}

	for (const reject of r.rejects) {
		if (reject.url === undefined) return null
		if (reject.steps === undefined) return null
		if (reject.page_text === undefined) return null
		if (reject.analysis === undefined) return null

		if (reject.analysis.yearly === undefined) return null;
		if (reject.analysis.name === undefined) return null;
		if (reject.analysis.city === undefined) return null;
		if (reject.analysis.state === undefined) return null;
		if (reject.analysis.month === undefined) return null;
		if (reject.analysis.firstDate === undefined) return null;
		if (reject.analysis.lastDate === undefined) return null;
		if (reject.analysis.nextDate === undefined) return null;
		if (reject.analysis.summary === undefined) return null;
		if (reject.analysis.description === undefined) return null;
	}

	if (r.num_errors > 0) {
		return null;
	}

	return r
}


async function doublecheck(useCache, chromeThrottler, gptThrottler, cacheCounter, otherEvents, event_i, event_name, event_city, event_state) {
	const cacheToken = event_state + ";" + event_city + ";" + event_name;
	const inner = async () => await doublecheckInner(chromeThrottler, gptThrottler, otherEvents, event_i, event_name, event_city, event_state);

	if (!useCache) {
		return await inner();
	} else {
		return await cached(
			cacheCounter,
			cacheToken,
			inner,
			// transform:
			readCachedObject,
			// cacheIf:
			(r) => !!r);
	}
}



const execFileAsync = util.promisify(execFile);

const openAiApiKey = "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";

const configuration =
		new Configuration({
		    organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		    apiKey: openAiApiKey,
		});
const openai = new OpenAIApi(configuration);

// Usage:
//   node index.js [use cache] [state] [question]
//   node index.js true "North Carolina" "What are the 3 weirdest yearly championships that happen in North Carolina?"

let useCache = process.argv[2]
if (useCache == "true") {
	useCache = true;
} else if (useCache == "false") {
	useCache = false;
} else {
	console.log("Please enter whether to use the cache for the first argument, true or false.")
	console.log("Example usage:")
	console.log("    node index.js true \"North Carolina\" \"What are the 3 weirdest yearly championships that happen in North Carolina?\"")
	process.exit(1)
}

const event_state = process.argv[3];
if (event_state == "") {
	console.log("Please enter a location for the second argument.")
	console.log("Example usage:")
	console.log("    node index.js true \"North Carolina\" \"What are the 3 weirdest yearly championships that happen in North Carolina?\"")
	process.exit(1)
}

const question = process.argv[4]
if (question == "") {
	console.log("Please enter a question for the third argument.")
	console.log("Example usage:")
	console.log("    node index.js true \"North Carolina\" \"What are the 3 weirdest yearly championships that happen in North Carolina?\"")
	process.exit(1)
}

function makeThrottler(msBetweenRequests) {
	let lastThrottleMillis = Date.now()
	return async () => {
		const now = Date.now()
		const millisSinceLastThrottle = now - lastThrottleMillis;
		// Lets only make a request every second or so, since we only get 60 RPS to chatgpt.
		if (millisSinceLastThrottle < msBetweenRequests) {
			await delay(msBetweenRequests - millisSinceLastThrottle);
		}
		lastThrottleMillis = now;
	}
}

class Semaphore {
    /**
     * Creates a semaphore that limits the number of concurrent Promises being handled
     * @param {*} maxConcurrentRequests max number of concurrent promises being handled at any time
     */
    constructor(maxConcurrentRequests = 1) {
        this.currentRequests = [];
        this.runningRequests = 0;
        this.maxConcurrentRequests = maxConcurrentRequests;
    }

    /**
     * Returns a Promise that will eventually return the result of the function passed in
     * Use this to limit the number of concurrent function executions
     * @param {*} fnToCall function that has a cap on the number of concurrent executions
     * @returns Promise that will resolve with the resolved value as if the function passed in was directly called
     */
    do(fnToCall) {
        return new Promise((resolve, reject) => {
            this.currentRequests.push({ resolve, reject, fnToCall });
            this.tryNext();
        });
    }

    tryNext() {
        if (!this.currentRequests.length) {
            return;
        } else if (this.runningRequests < this.maxConcurrentRequests) {
            let { resolve, reject, fnToCall } = this.currentRequests.shift();
            this.runningRequests++;
            let req = fnToCall();
            req.then((res) => resolve(res))
                .catch((err) => reject(err))
                .finally(() => {
                    this.runningRequests--;
                    this.tryNext();
                });
        }
    }
}

const gptThrottler = makeThrottler(120);
const chromeThrottler = new Semaphore(10);
const cacheCounter = { count: 0 };

console.log("Asking chatGPT:", question);
const event_lister_result =
	await runCommandForNullableStdout("node", ["./EventLister/index.js", openAiApiKey, question]);
	// "Mount Olive Pickle Festival; April; Mount Olive; This festival features a pickle eating contest, pickle-themed games, and the world's largest pickle, showcased in a parade.\n" +
	// "North Carolina Pickle Festival; May; Mount Olive; Offering live music, pickle juice drinking contest, and a pickle-themed pageant, this festival celebrates all things pickles."
if (event_lister_result === null) {
	console.log("Error in listing events!")
	process.exit()
}
if (!event_lister_result) {
	console.log("Empty response from listing events!")
	process.exit()
}

console.log("Event lister result:\n\n" + event_lister_result + "\n");
const event_strings = event_lister_result.split("\n")

const results = []
const otherEvents = []

console.log("CSV: Name,Location,Month,URL1,URL2")

let doublecheckFutures = [];

for (let [event_i, event_string] of event_strings.entries()) {
	const event_string = event_strings[event_i].trim()
	if (event_string == "") {
		continue
	}
	if (/^\d+/.test(event_string)) {
		console.log("Skipping malformed event string that started with number: " + event_string)
		continue
	}
	const event_string_parts = event_string.split(";")
	if (event_string_parts.length < 4) {
		console.log("Skipping malformed event string: " + event_string)
		continue
	}
	const usual_month = event_string_parts[1].trim()
	const event_city = event_string_parts[2].trim()
	const event_description = event_string_parts[3].trim();
	const original_event_name = event_string_parts[0].trim();
	const event_name = normalizeName(original_event_name, event_city, event_state);

	console.log("Doublechecking \"" + event_name + "\" in " + event_city + ", " + event_state);
	let doublecheckFuture =
		doublecheck(useCache, chromeThrottler, gptThrottler, cacheCounter, otherEvents, event_i, event_name, event_city, event_state)
		.then((doublecheckResult) => {
			if (!doublecheckResult) {
				console.log("Doublecheck failed for \"" + event_name + "\" in " + event_city + ", " + event_state);
				doublecheckResult = {confirms: [], found_month: "", num_errors: 1, num_promising: 0};
			}

			let {confirms, rejects, found_month, num_errors, num_promising} = doublecheckResult;
			const month = usual_month == found_month ? usual_month : "";

			results.push({
				name: event_name,
				city: event_city,
				state: event_state,
				confirms: confirms,
				rejects: rejects,
				month: month,
				num_errors: num_errors,
				num_promising: num_promising
			});

			if (confirms.length > 0) {
				console.log("CSV: \"" + event_name + "\",\"" + event_city + "," + event_state + "\",\"" + month + "\",\"" + confirms[0].url + "\",\"" + (confirms.length > 1 ? confirms[1].url : "") + "\",\"" + confirms[0].analysis.summary + "\"")
			}
		});
	doublecheckFutures.push(doublecheckFuture);
}

await Promise.all(doublecheckFutures);

console.log("")
console.log("")
for (const {name, city, confirms, month, num_errors} of results) {
	if (confirms.length > 0) {
		console.log("Found " + name + " in " + city + ", see:")
		for (const confirm of confirms) {
			console.log("    " + confirm.url)
		}
	}
}

console.log("")
console.log(cacheCounter.count + " from cache.")

console.log("")
console.log("")
for (const {name, city, confirms, num_errors} of results) {
	if (confirms.length == 0) {
		if (num_errors > 0) {
			console.log("Errors for " + name + " in " + city)
		} else {
			console.log("Hallucinated " + name + " in " + city)
		}
	}
}

console.log("")
console.log("")
for (const {analysis: {name, city, state, yearly, summary}} of otherEvents) {
	console.log("Other event: " + name + " in " + city + ", " + state + ", " + (yearly ? "yearly" : "(unsure if yearly)") + " summary: " + summary);
}


console.log("")
console.log("")
console.log("Name,Location,Month,URL1,URL2");
for (const {name, city, state, confirms, month} of results) {
	if (confirms.length > 0) {
		console.log( "\"" + name + "\",\"" + city + "," + state + "\",\"" + month + "\",\"" + confirms[0].url + "\",\"" + (confirms.length > 1 ? confirms[1].url : "") + "\",\"" + confirms[0].analysis.summary + "\"")
	}
}
