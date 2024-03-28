
import https from "https";
import syncFs from "fs";
import util from 'node:util';
import { execFile, spawn } from 'node:child_process'
import fs from "fs/promises";
import urlencode from 'urlencode';
import { logs, normalizeName, normalizeState, distinct, VException } from "../Common/utils.js";
import { analyzePage } from './analyze.js'
import { addSubmission } from '../Common/addSubmission.js'
import { parallelEachI } from "../Common/parallel.js";

const execFileAsync = util.promisify(execFile);

export async function analyze(
    openai,
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    chromeFetcher,
    chromeCacheCounter,
    gptThrottler,
    throttlerPriority,
    gptCacheCounter,
    otherEvents,
    model,
    event_i,
    event_name,
    event_city,
    event_state,
    maybeUrl,
    submissionId,
    broadSteps,
    search_result_i,
    url) {
  // We declare these up here so that the try block's exception can include them.
  let pageSteps = [];
  let pageText = null;
  let pageTextError = null;
  let analysis = null;
  let analysisStatus = null;

  try {

    await db.transaction(async (trx) => {
      const maybePageAnalysisRow = await trx.getPageAnalysis(submissionId, url, model);
      if (maybePageAnalysisRow) {
        analysisStatus = maybePageAnalysisRow.status;
        pageSteps = maybePageAnalysisRow.steps || [];
      }
      if (!analysisStatus) {
        logs(pageSteps, broadSteps)("Starting analysis for page:", url);
        await trx.startPageAnalysis(submissionId, url, model);
        analysisStatus = 'created';
      }
    });

    if (analysisStatus == 'created') {
      console.log("Resuming existing page analysis row for url:", url);
      // Continue
    } else {
      console.log("Already finished page analysis for url:", url);
      return;
    }

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, submissionId, pageSteps, event_i, event_name, search_result_i, url);
    pageText = pageText_;
    pageTextError = pageTextError_;

    if (pageTextError) {
      throw logs(pageSteps, broadSteps)("Bad pdf-to-text. Error:", pageTextError);
    }
    if (!pageText) {
      // This actually shouldnt happen, there's a check in getPageText.
      throw logs(pageSteps, broadSteps)("Seemingly successful pdf-to-text, but no page text and no error!");
    }

    const [matchness, analysis, analyzeInnerStatus] =
        await analyzePage(
            db, gptCacheCounter, gptThrottler, throttlerPriority, pageSteps, openai, submissionId, model, url, pageText, event_name, event_city, event_state);
    if (analyzeInnerStatus == 'created') {
      await db.finishPageAnalysis(submissionId, url, model, 'created', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'errors') {
      await db.finishPageAnalysis(submissionId, url, model, 'errors', pageSteps, analysis);
    } else if (analyzeInnerStatus == 'success') {
      if (!analysis || !analysis.name || !analysis.city || !analysis.state) {
        logs(pageSteps, broadSteps)("No analysis or city or state or name, rejecting.");
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      }
      if (matchness == 5) { // Multiple events
        logs(pageSteps, broadSteps)("Multiple events, ignoring.");
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      } else if (matchness == 4) { // Same city, confirmed.
        logs(broadSteps)(event_name, "confirmed by", url);

        const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = analysis;

        await db.finishPageAnalysis(submissionId, url, model, 'confirmed', pageSteps, analysis);
        return;
      } else if (matchness == 3) { // Same state, not quite confirm, submit it to otherEvents
        logs(broadSteps)("Not same, but discovered similar:", analysis.name);
        await addOtherEventSubmission(db, {
          inspiration_submission_id: submissionId,
          pageText,
          analysis,
          url
        });
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      } else if (matchness == 2) { // Same event but not even in same state, submit it to otherEvents
        logs(broadSteps)("Not same, but discovered similar:", analysis.name);
        await addOtherEventSubmission(db, {
          inspiration_submission_id: submissionId,
          pageText,
          analysis,
          url
        });
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      } else if (matchness == 1) { // Not same event, ignore it.
        logs(broadSteps)("Not same event at all, ignoring.");
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      } else if (matchness == 0) { // Not an event, skip
        logs(broadSteps)("Not an event, skipping.")
        await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
        return;
      } else {
        logs(broadSteps)("Wat analyze response:", matchness, analysis, analyzeInnerStatus);
        num_errors++;
      }
    } else {
      throw logs(broadSteps)("Wat analyze response:", matchness, analysis, analyzeInnerStatus)
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(pageSteps, broadSteps)(error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishPageAnalysis(submissionId, url, model, 'errors', pageSteps, analysis);
    return;
  }
}

export async function investigate(
    openai,
    scratchDir,
    db,
    googleSearchApiKey,
    fetchThrottler,
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
    model) {
  let investigationStatus = null;
  let broadSteps = [];
  let pageAnalyses = []
  let num_confirms = 0
  let num_promising = 0
  let num_errors = 0
  let unanimousMonth = null;

  await db.transaction(async (trx) => {
    const maybeInvestigation = await trx.getInvestigation(submissionId, model);
    if (maybeInvestigation) {
      investigationStatus = maybeInvestigation.status;
      broadSteps = maybeInvestigation.steps || [];
      pageAnalyses = maybeInvestigation.pageAnalyses || [];
    } else {
      investigationStatus = 'created';
      await trx.startInvestigation(submissionId, model);
    }
  });

  try {
    const googleQuery = event_name + " " + event_city + " " + event_state;
    logs(broadSteps)("Googling:", googleQuery);
    const searcherResult =
        await getSearchResult(
            db, googleSearchApiKey, fetchThrottler, searchThrottler, searchCacheCounter, throttlerPriority, submissionId, googleQuery);
    if (searcherResult == null) {
      logs(broadSteps)("Bad search for event ", event_name);
      const result = {
        pageAnalyses: [],
        month: "",
        numErrors: 1,
        numPromising: 0,
        name: event_name,
        city: event_city,
        state: event_state,
        broadSteps: broadSteps
      };
      return result;
    }
    const unfilteredResponseUrls = searcherResult.response;

    // Order them by shortest first, shorter URLs tend to be more canonical
    unfilteredResponseUrls.sort((a, b) => a.length - b.length);

    // If the submission came with a URL, move it to the top of the list.
    if (maybeUrl) {
      if (!unfilteredResponseUrls.includes(maybeUrl)) {
        unfilteredResponseUrls.unshift(maybeUrl);
      }
    }

    logs(broadSteps)("Google result URLs:", unfilteredResponseUrls);

    // Make sure we don't overwrite any existing page analyses
    let existingAnalysesUrls =
        (await db.getInvestigationPageAnalyses(submissionId, model))
        .map(row => row.url);
    // Add new rows for new URLs
    const urls = [];
    console.log("Filtering...");
    // We don't parallelize because we want to short-circuit once we hit 7
    for (const url of unfilteredResponseUrls) {
      if (urls.length >= 7) {
        console.log("Ignoring url, already at limit.")
        // Limit to 7
        break;
      }
      if (urls.includes(url)) {
        console.log("Skipping already included URL:", url);
        continue;
      }
      if (url == "") {
        logs(broadSteps)("Skipping blank url");
        continue;
      }
      const blacklistedDomains = [
        "youtube.com",
        "twitter.com"
      ];
      const urlLowercase = url.toLowerCase();
      if (blacklistedDomains.filter(entry => urlLowercase.includes(entry)).length) {
        logs(broadSteps)("Skipping blacklisted domain:", url);
        continue;
      }
      const cachedRow = await db.getPageText(url);
      if (cachedRow && cachedRow.text) {
        // We have it cached, so it must be a good url, proceed.
      } else {
        // We don't have it, so see if we can do a basic request to it
        await fetchThrottler.prioritized(throttlerPriority, async () => {
          try {
            console.log("Checking url", url);
            let finished = false;
            const controller = new AbortController();
            const abortTimeoutId = setTimeout(() => {
              if (!finished) {
                console.log("Aborting lagging request to", url);
                controller.abort()
              }
            }, 30000);
            const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
            controller.abort();
            finished = true;
            if (!response.ok) {
              logs(broadSteps)("Skipping non-ok'd url:", url);
              return;
            }
            const contentType = response.headers.get('content-type');
            if (!contentType) {
              logs(broadSteps)("No content-type, skipping:", url);
              return;
            }
            if (!contentType.includes('text/html')) {
              logs(broadSteps)("Skipping non-html response:", url);
              return;
            }
            // proceed
          } catch (error) {
            logs(broadSteps)("Skipping error'd url:", url, "error:", error);
            return;
          }
          // proceed
        });
        // proceed
      }
      console.log("Adding url", url);
      urls.push(url);
    }
    console.log("Filtered");

    let months = [];
    let num_errors = 0;

    // We dont parallelize this loop because we want it to early-exit if it finds
    // enough to confirm.
    let alreadyConfirmed = false;
    for (const [url_i, url] of urls.entries()) {
      if (alreadyConfirmed) {
        await db.finishPageAnalysis(submissionId, url, model, 'moot', [], {});
      } else {
        // This will update the rows in the database.
        await analyze(
            openai,
            scratchDir,
            db,
            googleSearchApiKey,
            fetchThrottler,
            searchThrottler,
            searchCacheCounter,
            chromeFetcher,
            chromeCacheCounter,
            gptThrottler,
            throttlerPriority,
            gptCacheCounter,
            otherEvents,
            model,
            event_i,
            event_name,
            event_city,
            event_state,
            maybeUrl,
            submissionId,
            broadSteps,
            url_i,
            url);
        const pageAnalysisRow =
            await db.getPageAnalysis(submissionId, url, model);
        if (pageAnalysisRow.status == 'created') {
          console.log("Analysis row is status created, pausing investigation.");
          // If it's still created status, then we're waiting on something external.
          // Update the steps at least and then return.
          await db.finishInvestigation(
              submissionId, model, 'created', {month: unanimousMonth}, broadSteps);
          return;
        } else if (pageAnalysisRow.status == 'confirmed') {
          console.log("Counting confirmation from url:", url);
          num_confirms++;
          const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = pageAnalysisRow;
          if (month) {
            months.push(month);
          }
          const promising = yearly || (nextDate != null)
          if (promising) {
            num_promising++;
          }
          if (num_confirms + num_promising >= 5) {
            logs(broadSteps)("Found enough confirming " + event_name + ", stopping!");
            alreadyConfirmed = true;
            // continue on, we're going to mark the rest as moot
          }
        } else if (pageAnalysisRow.status == 'errors') {
          console.log("Counting error from url:", url);
          num_errors++;
        } else if (pageAnalysisRow.status == 'rejected') {
          console.log("Counting reject from url:", url);
          // Do nothing
        } else {
          throw "Weird status from analyze: " + pageAnalysisRow.status;
        }
      }
    }
    if (alreadyConfirmed) {
      months = distinct(months);
      unanimousMonth = months.length == 1 ? months[0] : "";
      logs(broadSteps)("Unanimous month?:", unanimousMonth);

      await db.finishInvestigation(submissionId, model, 'confirmed', {month: unanimousMonth}, broadSteps);
      return;
    }
    if (num_errors == 0) {
      logs(broadSteps)("Didn't find enough confirming " + event_name + ", concluding failed.");
      // If we get here, then things are final and we don't have enough confirms.
      await db.finishInvestigation(submissionId, model, 'failed', {month: unanimousMonth}, broadSteps);
    } else {
      await db.finishInvestigation(submissionId, model, 'errors', {month: unanimousMonth}, broadSteps);
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(broadSteps)(error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishInvestigation(submissionId, model, 'errors', {month: unanimousMonth}, broadSteps);
  }
}

async function getSearchResult(db, googleSearchApiKey, fetchThrottler, searchThrottler, searchCacheCounter, throttlerPriority, submissionId, googleQuery) {
  const maybeSearcherResult =
      await db.getCachedGoogleResult(googleQuery);
  if (maybeSearcherResult) {
    const {response} = maybeSearcherResult;
    console.log("Using cached google query");
    searchCacheCounter.count++;
    return {response};
  }
  const response =
      await searchThrottler.prioritized(throttlerPriority, async () => {
        console.log("Released for Google!", throttlerPriority)
        console.log("Expensive", submissionId, "google:", googleQuery);
        // debugger;
        return await googleSearch(googleSearchApiKey, googleQuery);
      });
  console.log("Caching google result");
  await db.cacheGoogleResult({query: googleQuery, response: response});
  return {response: response};
}

async function getPageTextInner(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, submissionId, steps, eventI, eventName, resultI, url) {
  const pdfOutputPath = scratchDir + "/result" + eventI + "-" + resultI + ".pdf"
  console.log("Asking for pdf for " + url + " to " + pdfOutputPath);
  try {
    console.log("Expensive", submissionId, "chromeFetcher:", url);
    // debugger;
    await chromeFetcher.send(url + " " + pdfOutputPath);
  } catch (err) {
    const error =
        "Bad fetch/browse for event " + eventName + " result " + url + ": " + 
        (err.status ?
            err.status + ": " + err.rest :
            err);
    console.log(error);
    return {text: null, error};
  }

  const txt_path = scratchDir + "/" + url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
  const commandArgs = ["./PdfToText/main.py", pdfOutputPath, txt_path];
  const pdftotextExitCode = await runCommandForStatus("python3", commandArgs)
  console.log("Ran PDF-to-text, exit code:", pdftotextExitCode)
  if (pdftotextExitCode !== 0) {
    const error = "Bad PDF-to-text for event " + eventName + " at url " + url + " pdf path " + pdfOutputPath;
    console.log(error);
    return {text: null, error};
  }
  steps.push(["Created text in", txt_path])
  const text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
  if (!text) {
    const error = "No result text found for " + eventName + ", args: " + commandArgs.join(" ");
    console.log(error);
    return {text: null, error};
  }

  return {text, error: null};
}

async function getPageText(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, submissionId, steps, eventI, eventName, resultI, url) {
  // This used to be wrapped in a transaction but I think it was causing the connection
  // pool to get exhausted.

  const cachedPageTextRow = await db.getPageText(url);
  if (cachedPageTextRow) {
    chromeCacheCounter.count++;
    return cachedPageTextRow;
  }

  const {text, error} =
      await getPageTextInner(
          scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, submissionId, steps, eventI, eventName, resultI, url);
  // This automatically merges on conflict
  await db.cachePageText({url, text, error});
  return {text, error};
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
    return body.items.map(x => x.link);
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
  await db.insertSubmission({
    submission_id: crypto.randomUUID(),
    name,
    state: state && normalizeState(state),
    city,
    description: summary,
    status: 'created',
    url,
    origin_query: null,
    need: 0
  });
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

// // Function to fetch PDF from URL and save it to a file
// function fetchPDF(url, filePath) {
//     return new Promise((resolve, reject) => {
//         const file = syncFs.createWriteStream(filePath);

//         if (url.startsWith("https://")) {
//           https.get(url, response => {
//               response.pipe(file);
//               file.on('finish', () => {
//                   file.close(resolve);
//               });
//           }).on('error', error => {
//               fs.unlink(filePath, () => reject(error));
//           });
//       } else {
//         http.get(url, response => {
//               response.pipe(file);
//               file.on('finish', () => {
//                   file.close(resolve);
//               });
//           }).on('error', error => {
//               fs.unlink(filePath, () => reject(error));
//           });
//       }
//     });
// }
