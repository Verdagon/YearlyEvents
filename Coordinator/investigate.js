
import util from 'node:util';
import { execFile, spawn } from 'node:child_process'
import fs from "fs/promises";
import urlencode from 'urlencode';
import { logs, normalizeName, distinct, VException } from "../Common/utils.js";
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

  try {
    console.log("bork 1")

    await db.transaction(async (trx) => {
      const maybePageAnalysisRow = await trx.getPageAnalysis(submissionId, url, model);
      if (maybePageAnalysisRow) {
        const analysisStatus = maybePageAnalysisRow.status;
        pageSteps = maybePageAnalysisRow.steps || [];

        if (!analysisStatus) {
          logs(pageSteps, broadSteps)("Bad analysis status, assuming created.");
          analysisStatus = 'created';
        }
        if (analysisStatus == 'created') {
          console.log("Resuming existing page analysis row for url:", url);
          // Continue
        } else {
          console.log("Already finished page analysis for url:", url);
          return;
        }
      } else {
        logs(pageSteps)("Starting analysis for page:", url);
        await trx.startPageAnalysis(submissionId, url, model);
      }
    });

    const {text: pageText_, error: pageTextError_} =
        await getPageText(
            scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, pageSteps, event_i, event_name, search_result_i, url);
    pageText = pageText_;
    pageTextError = pageTextError_;

    if (!pageText) {
      throw logs(pageSteps, broadSteps)("No page text, skipping. Error:", pageTextError);
    }

    const [matchness, analysis] =
        await analyzePage(
            db, gptCacheCounter, gptThrottler, throttlerPriority, pageSteps, openai, model, url, pageText, event_name, event_city, event_state);

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
      });
      await db.finishPageAnalysis(submissionId, url, model, 'rejected', pageSteps, analysis);
      return;
    } else if (matchness == 2) { // Same event but not even in same state, submit it to otherEvents
      logs(broadSteps)("Not same, but discovered similar:", analysis.name);
      await addOtherEventSubmission(db, {
        inspiration_submission_id: submissionId,
        pageText,
        analysis
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
      logs(broadSteps)("Wat response:", matchness, analysis);
      num_errors++;
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

  if (investigationStatus != 'created') {
    console.log("Investigation already done (" + investigationStatus + "), returning.");
    return;
  }

  try {
    const googleQuery = event_name + " " + event_city + " " + event_state;
    logs(broadSteps)("Googling:", googleQuery);
    const searcherResult =
        await getSearchResult(
            db, googleSearchApiKey, searchThrottler, searchCacheCounter, throttlerPriority, googleQuery);
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
    const responseUrls = searcherResult.response;

    // Order them by shortest first, shorter URLs tend to be more canonical
    responseUrls.sort((a, b) => a.length - b.length);

    // If the submission came with a URL, move it to the top of the list.
    if (maybeUrl) {
      if (!responseUrls.includes(maybeUrl)) {
        responseUrls.unshift(maybeUrl);
      }
    }

    logs(broadSteps)("Google result URLs:", responseUrls);

    // Make sure we don't overwrite any existing page analyses
    let urls =
        (await db.getInvestigationPageAnalyses(submissionId, model))
        .map(row => row.url);
    // Add new rows for new URLs
    for (const responseUrl of responseUrls) {
      logs(broadSteps)("Encountered new search result url:", responseUrl);
      if (responseUrl == "") {
        logs(broadSteps)("Skipping blank url");
        continue
      }
      if (responseUrl.includes("youtube.com")) {
        logs(broadSteps)("Skipping blacklisted domain");
        continue
      }
      if (responseUrl.includes("twitter.com")) {
        logs(broadSteps)("Skipping blacklisted domain");
        continue
      }
      urls.push(responseUrl);
    }
    urls = distinct(urls);

    // We dont parallelize this loop because we want it to early-exit if it finds
    // enough to confirm.
    for (const [url_i, url] of urls.entries()) {
      // This will update the rows in the database.
      await analyze(
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
    }

    const pageAnalysesRows = await db.getInvestigationPageAnalyses(submissionId, model);
    // If there are any still in 'created' status then they're waiting on something
    // external to happen, so return early.
    if (pageAnalysesRows.filter(row => row.status == 'created').length) {
      // Update the steps at least
      await db.finishInvestigation(
          submissionId, model, 'created', {month: unanimousMonth}, broadSteps);
      return;
    }

    let months = [];

    for (const analysisRow of pageAnalysesRows) {
      const {url, steps, status: pageStatus, analysis} = analysisRow;

      if (pageStatus == 'created') {
        // Should never get here
      } else if (pageStatus == 'confirmed') {
        console.log("Counting confirmation from url:", url);
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
          logs(broadSteps)("Found enough confirming " + event_name + ", stopping!");

          months = distinct(months);
          unanimousMonth = months.length == 1 ? months[0] : "";
          logs(broadSteps)("Unanimous month?:", unanimousMonth);

          await db.finishInvestigation(submissionId, model, 'confirmed', {month: unanimousMonth}, broadSteps);
          return;
        }
      } else if (pageStatus == 'errors') {
        console.log("Counting error from url:", url);
        num_errors++;
      } else if (pageStatus == 'rejected') {
        console.log("Counting reject from url:", url);
        // Do nothing
      } else {
        throw "Weird status from analyze: " + pageStatus;
      }
    }

    logs(broadSteps)("Didn't find enough confirming " + event_name + ", concluding failed.");
    // If we get here, then things are final and we don't have enough confirms.
    await db.finishInvestigation(submissionId, model, 'failed', {month: unanimousMonth}, broadSteps);

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
        console.log("Expensive: Google:", googleQuery);
        return await googleSearch(googleSearchApiKey, googleQuery);
      });
  await db.cacheGoogleResult({query: googleQuery, response: response});
  return {response: response};
}

async function getPageText(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, steps, eventI, eventName, resultI, url) {
  // This used to be wrapped in a transaction but I think it was causing the connection
  // pool to get exhausted.

    console.log("bork 2")
  const cachedPageTextRow = await db.getPageText(url);
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
      console.log("Expensive: chromeFetcher:", url);
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
    const cachedPageTextRow = await trx.getPageText(url);
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
