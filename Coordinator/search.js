
import urlencode from 'urlencode';

export async function getSearchResult(db, googleSearchApiKey, fetchThrottler, searchThrottler, searchCacheCounter, throttlerPriority, submissionId, googleQuery) {
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
