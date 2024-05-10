
import { logs, normalizeName, normalizePlace, normalizeState, distinct, VException } from "../Common/utils.js";
import { analyzePageOuter, analyzeMatchOuter } from './analyze.js'
import { getSearchResultOuter } from './search.js'

export async function investigate(
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
    event_i,
    matchName,
    matchCity,
    matchState,
    maybeUrl,
    submissionId,
    overrideModel) {
  let investigationStatus = null;
  let broadSteps = [];
  let pageAnalyses = []
  let num_confirms = 0
  let num_promising = 0
  let num_errors = 0
  let unanimousMonth = null;

  await db.transaction(async (trx) => {
    const maybeInvestigation = await trx.getInvestigation(submissionId);
    if (maybeInvestigation) {
      investigationStatus = maybeInvestigation.status;
      broadSteps = maybeInvestigation.steps || [];
      pageAnalyses = maybeInvestigation.pageAnalyses || [];
    } else {
      investigationStatus = 'created';
      await trx.startInvestigation(submissionId);
    }
  });

  try {
    const googleQuery = matchName + " " + matchCity + " " + matchState;
    const urls =
        await getSearchResultOuter(
            db,
            googleSearchApiKey,
            fetchThrottler,
            searchThrottler,
            searchCacheCounter,
            throttlerPriority,
            submissionId,
            broadSteps,
            maybeUrl,
            (await db.getInvestigationAnalyses(submissionId, 4)).map(row => row.url),
            googleQuery);
    if (urls == null) {
      await db.finishInvestigation(submissionId, 'errors', null, broadSteps);
      return;
    }

    let months = [];

    // We dont parallelize this loop because we want it to early-exit if it finds
    // enough to confirm.
    let alreadyConfirmed = false;
    for (const [url_i, url] of urls.entries()) {
      if (alreadyConfirmed) {
        await db.finishMatchAnalysis(submissionId, url, 'moot', [], {});
        await db.finishPageAnalysis(url, 'moot', [], {});
      } else {
        // This will update the rows in the database.
        await analyzeMatchOuter(
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
            submissionId,
            overrideModel,
            event_i,
            matchName,
            matchCity,
            matchState,
            broadSteps,
            url_i,
            url);

        const matchAnalysisRow =
            await db.getMatchAnalysis(submissionId, url);
        if (matchAnalysisRow.status == 'created') {
          console.log("Analysis row is status created, pausing investigation.");
          // If it's still created status, then we're waiting on something external.
          // Update the steps at least and then return.
          await db.finishInvestigation(
              submissionId, 'created', {month: unanimousMonth}, broadSteps);
          return;
        } else if (matchAnalysisRow.status == 'errors') {
          console.log("Counting error from url:", url);
          num_errors++;
          continue;
        } else if (matchAnalysisRow.status == 'rejected') {
          console.log("Counting reject from url:", url);
          continue;
        } else if (matchAnalysisRow.status == 'success') {
          // Proceed
        } else {
          throw "Weird status from analyze: " + matchAnalysisRow.status;
        }

        // We know we successfully measured the matchness, let's grab the dependee
        // page analysis too
        const pageAnalysisRow = await db.getPageAnalysis(url);

        if (matchAnalysisRow.matchness == 4) { // matches city
          // Good, proceed
        } else if (matchAnalysisRow.matchness == 2 || matchAnalysisRow.matchness == 3) {
          logs(broadSteps)(
              "Adding unrelated event:",
              pageAnalysisRow.analysis.name,
              pageAnalysisRow.analysis.city,
              pageAnalysisRow.analysis.state,
              pageAnalysisRow.analysis.summary);
          await addOtherEventSubmission(
              db,
              url,
              pageAnalysisRow.analysis.name,
              pageAnalysisRow.analysis.city,
              pageAnalysisRow.analysis.state,
              pageAnalysisRow.analysis.summary);
          continue;
        } else if (matchAnalysisRow.matchness == 1) { // Doesnt match anywhere
          logs(broadSteps)("Doesn't match anywhere, bailing.");
          continue;
        } else {
          throw logs(broadSteps)("Wat response from match analysis:", matchAnalysisRow);
        }

        // If we get here, this page matches.
        console.log("Counting confirmation from url:", url);
        num_confirms++;
        // Since we know it matches, we can trust and use this information from the page analysis.
        const {yearly, name, city, state, firstDate, lastDate, nextDate, summary, month} = pageAnalysisRow.analysis;

        if (month) {
          months.push(month);
        }
        const promising = yearly || (nextDate != null)
        if (promising) {
          num_promising++;
        }
        if (num_confirms + num_promising >= 5) {
          logs(broadSteps)("Found enough confirming " + matchName + ", stopping!");
          alreadyConfirmed = true;
          // continue on, we're going to mark the rest as moot
        }
      }
    }
    if (num_confirms) {
      months = distinct(months);
      unanimousMonth = months.length == 1 ? months[0] : "";
      logs(broadSteps)("Found", num_confirms, "confirms, unanimous month:", unanimousMonth);

      await db.finishInvestigation(submissionId, 'confirmed', {month: unanimousMonth}, broadSteps);
      return;
    }
    if (num_errors == 0) {
      logs(broadSteps)("Didn't find enough confirming " + matchName + ", concluding failed.");
      // If we get here, then things are final and we don't have enough confirms.
      await db.finishInvestigation(submissionId, 'failed', {month: unanimousMonth}, broadSteps);
    } else {
      await db.finishInvestigation(submissionId, 'errors', {month: unanimousMonth}, broadSteps);
    }
  } catch (error) {
    // Make sure the error's contents is put into the steps.
    // (unless it's a VException, was already logged to the steps)
    if (!(error instanceof VException)) {
      logs(broadSteps)(error);
    } else {
      console.log("Already logged error:", error);
    }
    await db.finishInvestigation(submissionId, 'errors', {month: unanimousMonth}, broadSteps);
  }
}

async function addOtherEventSubmission(db, url, name, city, state, summary) {
  await db.insertSubmission({
    submission_id: crypto.randomUUID(),
    name,
    state: state && normalizeState(state),
    city: city && normalizePlace(city),
    description: summary,
    status: 'created',
    url,
    origin_query: null,
    need: 0,
    scrutinize: 0
  });
}
