
import util from 'node:util';
import { execFile, spawn } from 'node:child_process'
import fs from "fs/promises";
import urlencode from 'urlencode';
import { logs, normalizeName, distinct } from "../Common/utils.js";
import { analyzePage } from './analyze.js'
import { addSubmission } from '../Common/addSubmission.js'
import { parallelEachI } from "../Common/parallel.js";

const execFileAsync = util.promisify(execFile);

export async function analyze(
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
    event_i,
    event_name,
    event_city,
    event_state,
    maybeUrl,
    submissionId,
    pageSteps,
    search_result_i,
    url) {
  // We declare these up here so that the try block's exception can include them.
  const pageSteps = [];
  let pageText = null;
  let pageTextError = null;
  let analysis = null;

  try {
    console.log("bork 1")

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, pageSteps, event_i, event_name, search_result_i, url);
    pageText = pageText_;
    pageTextError = pageTextError_;

    if (!pageText) {
      throw logs(pageSteps, broadSteps)("No page text, skipping. Error:", pageTextError);
    }

    logs(pageSteps)("Analyzing page...");
    const [matchness, analysis] =
        await analyzePage(
            db, gptCacheCounter, gptThrottler, throttlerPriority, pageSteps, openai, url, pageText, event_name, event_city, event_state);

    if (matchness == 5) { // Multiple events
      logs(pageSteps, broadSteps)("Multiple events, ignoring.");

      return {
        status: 'rejected',
        url,
        pageText,
        pageTextError,
        analysis: analysis,
        steps: pageSteps
      };
    } else if (matchness == 4) { // Same city, confirmed.
      logs(pageSteps, broadSteps)(event_name, "confirmed by", url);

      const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;

      return {
        status: 'confirmed',
        url,
        pageText,
        analysis: analysis,
        month: month,
        steps: pageSteps
      };
    } else if (matchness == 3) { // Same state, not quite confirm, submit it to otherEvents
      await addOtherEventSubmission(db, {
        inspiration_submission_id: submissionId,
        url,
        pageText,
        analysis,
      });
      
      logs(pageSteps, broadSteps)("Rediscovered:", analysis.name);
      return {
        status: 'rejected',
        url,
        pageText,
        pageTextError,
        analysis,
        steps: pageSteps
      };
    } else if (matchness == 2) { // Same event but not even in same state, submit it to otherEvents
      await addOtherEventSubmission(db, {
        inspiration_submission_id: submissionId,
        url,
        pageText,
        analysis
      });
      
      logs(pageSteps, broadSteps)("Rediscovered:", analysis.name);
      return {
        status: 'rejected',
        url,
        pageText,
        pageTextError,
        analysis,
        steps: pageSteps
      };
    } else if (matchness == 1) { // Not same event, ignore it.
      logs(pageSteps, broadSteps)("Not same event at all, ignoring.");

      return {
        status: 'rejected',
        url,
        pageText,
        pageTextError,
        analysis,
        steps: pageSteps
      };
    } else if (matchness == 0) { // Not an event, skip
      logs(pageSteps, broadSteps)("Not an event, skipping.")

      return {
        status: 'rejected',
        url,
        pageText,
        pageTextError,
        analysis,
        steps: pageSteps
      };
    } else {
      logs(pageSteps, broadSteps)("Wat response:", matchness, analysis);
      num_errors++;
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(pageSteps)(error);
    }
    return {
      status: "errors",
      url,
      pageText,
      pageTextError,
      analysis,
      steps: pageSteps
    };
  }
}

export async function investigate(
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
    event_i,
    event_name,
    event_city,
    event_state,
    maybeUrl,
    submissionId) {
  const broadSteps = [];
  const googleQuery = event_name + " " + event_city + " " + event_state;
  logs(broadSteps)("Googling:", googleQuery);
  const searcherResult = await getSearchResult(db, googleSearchApiKey, searchThrottler, searchCacheCounter, throttlerPriority, googleQuery);
  if (searcherResult == null) {
    logs(broadSteps)("Bad search for event ", event_name);
    const result = {
      pageAnalyses: [],
      month: "",
      num_errors: 1,
      num_promising: 0,
      name: event_name,
      city: event_city,
      state: event_state,
      broad_steps: broadSteps
    };
    return result;
  }
  const response = searcherResult.response;

  if (maybeUrl) {
    if (!response.includes(maybeUrl)) {
      response.unshift(maybeUrl);
    }
  }

  // Order them by shortest first, shorter URLs tend to be more canonical
  response.sort((a, b) => a.length - b.length);

  const pageAnalyses = []
  let num_confirms = 0
  let num_promising = 0
  let num_errors = 0
  let months = [];

  // We dont parallelize this loop because we want it to early-exit if it finds
  // enough to confirm.
  for (const [search_result_i, search_result_url] of response.entries()) {
    const pageSteps = [];

    logs(pageSteps, broadSteps)("Considering", search_result_url);

    if (search_result_url == "") {
      logs(pageSteps, broadSteps)("Skipping blank url");
      continue
    }
    if (search_result_url.includes("youtube.com")) {
      logs(pageSteps, broadSteps)("Skipping blacklisted domain");
      continue
    }
    if (search_result_url.includes("twitter.com")) {
      logs(pageSteps, broadSteps)("Skipping blacklisted domain");
      continue
    }

    const analysis =
        analyze(
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
            event_i,
            event_name,
            event_city,
            event_state,
            maybeUrl,
            submissionId,
            pageSteps,
            search_result_i,
            search_result_url);
    pageAnalyses.push(analysis);

    if (analysis.status == 'confirmed') {
      num_confirms++;

      const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;

      if (month) {
        months.push(month);
      }

      const promising = yearly || (nextDate != null)
      if (promising) {
        num_promising++;
      }

      if (num_confirms + num_promising >= 5) {
        logs(pageSteps, broadSteps)("Found enough confirming " + event_name + ", continuing!");
        break;
      }
    } else if (analysis.status == 'errors') {
      num_errors++;
    } else if (analysis.status == 'rejected') {
      // Do nothing
    } else {
      throw "Weird status from analyze: " + analysis.status;
    }
  }

  months = distinct(months);
  const unanimousMonth = months.length == 1 ? months[0] : "";

  const investigation = {
    pageAnalyses: pageAnalyses,
    month: unanimousMonth,
    num_errors: num_errors,
    num_promising: num_promising,
    name: event_name,
    city: event_city,
    state: event_state,
    broad_steps: broadSteps
  };
  return investigation;
}

async function getSearchResult(db, googleSearchApiKey, searchThrottler, searchCacheCounter, throttlerPriority, googleQuery) {
  const maybeSearcherResult =
      await db.getFromDb("GoogleCache", searchCacheCounter, {"query": googleQuery}, ["response"]);
  if (maybeSearcherResult) {
    const {response} = maybeSearcherResult;
    return {response};
  }
  const response =
      await searchThrottler.prioritized(throttlerPriority, async () => {
        console.log("Released for Google!", throttlerPriority)
        return await googleSearch(googleSearchApiKey, googleQuery);
      });
  await db.cacheGoogleResult({query: googleQuery, response: response});
  return {response: response};
}

async function getPageText(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, steps, eventI, eventName, resultI, url) {
  // This used to be wrapped in a transaction but I think it was causing the connection
  // pool to get exhausted.

    console.log("bork 2")
  const cachedPageTextRow =
      await db.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
    console.log("bork 2.4")
  if (cachedPageTextRow) {
    console.log("bork 2.5")
    chromeCacheCounter.count++;
    return cachedPageTextRow;
  }

    console.log("bork 3")
  const pdfOutputPath = scratchDir + "/result" + eventI + "-" + resultI + ".pdf"
  console.log("Asking for pdf for " + url + " to " + pdfOutputPath);
  try {
    if (url.includes(".pdf")) {
      await fetchPDF(url, pdfOutputPath);
    } else {
      await chromeFetcher.send(url + " " + pdfOutputPath);
    }
    console.log("bork 4")
  } catch (err) {
    const error =
        "Bad fetch/browse for event " + eventName + " result " + url + ": " + 
        (err.status ?
            err.status + ": " + err.rest :
            err);
    console.log(error)
    // Don't save errors
    // await db.transaction(async (trx) => {
    //  const cachedPageTextRow =
    //      await trx.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
    //  if (!cachedPageTextRow) {
    //    await trx.cachePageText({url, text: null, error});
    //  }
    // });
    return {text: null, error};
  }

    console.log("bork 5")
  const txt_path = scratchDir + "/" + url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
  const pdftotextExitCode =
      await runCommandForStatus(
          "python3", ["./PdfToText/main.py", pdfOutputPath, txt_path])
  console.log("Ran PDF-to-text, exit code:", pdftotextExitCode)
  if (pdftotextExitCode !== 0) {
    const error = "Bad PDF-to-text for event " + eventName + " at url " + url + " pdf path " + pdfOutputPath;
    console.log(error);
    // Don't save errors
    // await db.transaction(async (trx) => {
    //  const cachedPageTextRow =
    //      await trx.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
    //  if (!cachedPageTextRow) {
    //    await trx.cachePageText({url, text: null, error});
    //  }
    // });
    return {text: null, error};
  }
  steps.push(["Created text in", txt_path])
  const text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
  if (!text) {
    const error = "No result text found for " + eventName + " at url " + url;
    console.log(error);
    // Don't save errors
    // await db.transaction(async (trx) => {
    //  const cachedPageTextRow =
    //      await trx.getFromDb("PageTextCache", chromeCacheCounter, {"url": url});
    //  if (!cachedPageTextRow) {
    //    await trx.cachePageText({url, text: null, error});
    //  }
    // });
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
      throw "!response.ok from google: " + JSON.stringify(response);
    }
    const body = await response.json();
    if (body.spelling && body.spelling.correctedQuery) {
      console.log("Searching google suggested corrected query:", query);
      return await googleSearch(googleSearchApiKey, body.spelling.correctedQuery);
    }
    if (body.items == null) {
      throw "Bad response error, no items: " + JSON.stringify(body);
    }
    if (body.items.length == null) {
      throw "Bad response error, items empty: " + JSON.stringify(body);
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

async function addOtherEventSubmission(db, otherEvent) {
  const {url, analysis: {name, city, state, yearly, summary}} = otherEvent;
  console.log("Other event: " + name + " in " + city + ", " + state + ", " + (yearly ? "yearly" : "(unsure if yearly)") + " summary: " + summary);

  console.log("zork 1")
  const existing = await db.getExistingSubmission(name, city, state);
  if (!existing) {
    await addSubmission(db, {status: 'created', name, city, state, description: summary, url});
  }
  console.log("zork 3")
}

async function runCommandForStatus(program, args) {
  try {
    // Seems to return an object with just two fields, like:
    // { stdout: 'Success!\n', stderr: '' }
    await execFileAsync(program, args);
    return 0;
  } catch (e) {
    if (e.exitCode !== undefined || e.stdout !== undefined || e.stderr !== undefined) {
      console.log("Command failed: ", program, args);
      console.log("exitCode:\n" + e.exitCode);
      console.log("stdout:\n" + e.stdout);
      console.log("stderr:\n" + e.stderr);
      return e.exitCode;
    } else {
      console.log("Command failed: ", program, args, "Error:", e);
      throw e;
    }
  }
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
