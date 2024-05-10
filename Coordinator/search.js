
import urlencode from 'urlencode';
import { logs, normalizeName, VException } from "../Common/utils.js";


export async function getSearchResultOuter(
    db,
    googleSearchApiKey,
    fetchThrottler,
    searchThrottler,
    searchCacheCounter,
    throttlerPriority,
    submissionId,
    broadSteps,
    maybeFirstUrl,
    existingUrls,
    googleQuery) {
  logs(broadSteps)("Googling:", googleQuery);
  const searcherResult =
      await getSearchResultInner(
          db, googleSearchApiKey, fetchThrottler, searchThrottler, searchCacheCounter, throttlerPriority, submissionId, googleQuery);
  if (searcherResult == null) {
    logs(broadSteps)("Bad search for event ", matchName);
    return null;
  }
  const unfilteredResponseUrls = searcherResult.response;

  // Order them by shortest first, shorter URLs tend to be more canonical
  unfilteredResponseUrls.sort((a, b) => a.length - b.length);

  // If the submission came with a URL, move it to the top of the list.
  if (maybeFirstUrl) {
    if (!unfilteredResponseUrls.includes(maybeFirstUrl)) {
      unfilteredResponseUrls.unshift(maybeFirstUrl);
    }
  }

  logs(broadSteps)("Google result URLs:", unfilteredResponseUrls);

  // Make sure we don't overwrite any existing page analyses
  const urls = existingUrls;
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
          logs(broadSteps)("Skipping error'd url:", url, "error:", Object.keys(error), error);
          return;
        }
        // proceed
      });
      // proceed
    }
    console.log("Adding url", url);
    urls.push(url);
  }

  return urls;
}

async function getSearchResultInner(db, googleSearchApiKey, fetchThrottler, searchThrottler, searchCacheCounter, throttlerPriority, submissionId, googleQuery) {
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
        console.log("Search expensive", submissionId, "google:", googleQuery);
        // debugger;
        return await googleSearch(googleSearchApiKey, googleQuery);
      });
  console.log("Caching google result");
  await db.cacheGoogleResult({query: googleQuery, response: response});
  return {response: response};
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
      console.log("Google search error:", jsonError);
      throw jsonError;
    } else {
      throw "Generic error from API: " + error + ": " + JSON.stringify(error);
    }
  }
}
