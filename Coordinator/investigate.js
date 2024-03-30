
import { logs, normalizeState, distinct, VException } from "../Common/utils.js";
import { analyzePageOuter, analyzeMatchOuter } from './analyze.js'
import { getSearchResult } from './search.js'

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
    const urls = 
        (await db.getInvestigationAnalyses(submissionId, model))
        .map(row => row.url);
    // Add new rows for new URLs
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

    let months = [];

    // We dont parallelize this loop because we want it to early-exit if it finds
    // enough to confirm.
    let alreadyConfirmed = false;
    for (const [url_i, url] of urls.entries()) {
      if (alreadyConfirmed) {
        await db.finishMatchAnalysis(submissionId, url, model, 'moot', [], {});
        await db.finishPageAnalysis(url, model, 'moot', [], {});
      } else {
        // This will update the rows in the database.
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
            gptThrottler,
            throttlerPriority,
            gptCacheCounter,
            model,
            event_i,
            event_name,
            event_city,
            event_state,
            submissionId,
            broadSteps,
            url_i,
            url);
        const pageAnalysisRow =
            await db.getPageAnalysis(url, model);
        if (pageAnalysisRow.status == 'created') {
          console.log("Analysis row is status created, pausing investigation.");
          // If it's still created status, then we're waiting on something external.
          // Update the steps at least and then return.
          await db.finishInvestigation(
              submissionId, model, 'created', {month: unanimousMonth}, broadSteps);
          return;
        } else if (pageAnalysisRow.status == 'errors') {
          console.log("Counting error from url:", url);
          num_errors++;
          continue;
        } else if (pageAnalysisRow.status == 'rejected') {
          console.log("Counting reject from url:", url);
          continue;
        } else if (pageAnalysisRow.status == 'success') {
          // Proceed
        } else {
          throw "Weird status from analyze: " + pageAnalysisRow.status;
        }

        // This will update the rows in the database.
        await analyzeMatchOuter(
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
            submissionId,
            model,
            event_i,
            event_name,
            event_city,
            event_state,
            broadSteps,
            url_i,
            url);
        const matchAnalysisRow =
            await db.getMatchAnalysis(submissionId, url, model);
        if (matchAnalysisRow.status == 'created') {
          console.log("Analysis row is status created, pausing investigation.");
          // If it's still created status, then we're waiting on something external.
          // Update the steps at least and then return.
          await db.finishInvestigation(
              submissionId, model, 'created', {month: unanimousMonth}, broadSteps);
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
        if (!name) {
          throw "wat";
        }

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
      }
    }
    if (num_confirms) {
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

async function addOtherEventSubmission(db, url, name, city, state, summary) {
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
}
