import fs from "fs/promises";
import url from "url";
import querystring from "querystring";
import { Configuration, OpenAIApi } from "openai";
import http from 'http';
import { gptListEvents}  from '../gptListEvents.js';
import { normalizeName } from '../utils.js'
import { LocalDb } from '../LocalDb/localdb.js'
import { addSubmission } from '../addSubmission.js'
// import { approveSubmission, rejectSubmission }  from '../approveSubmission.js';
// import { getUnconsideredSubmissions }  from '../getUnconsideredSubmissions.js';
import { Semaphore, parallelEachI } from "../parallel.js"
import { Eta } from "eta";
import { normalizeState } from "../utils.js"

const eta = new Eta();

const port = 8080

const dbPath = process.argv[2];
if (!dbPath) {
  throw "Expected db path for first argument, but was missing.";
}

const openAiApiKey = process.argv[3];
if (typeof openAiApiKey != "string") {
  throw "Expected OpenAI api key for second argument, but was missing.";
}
if (!openAiApiKey.startsWith("sk-")) {
  throw "Expected OpenAI api key for second argument, but was malformed.";
}

const db = new LocalDb(null, dbPath);

const configuration =
    new Configuration({
        organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
        apiKey: openAiApiKey,
    });
const openai = new OpenAIApi(configuration);

const gptThrottler = new Semaphore(null, 120);

// Create a server object:
const server = http.createServer(async function (req, res) {
  const parsedUrl = url.parse(req.url);
  const queryParams = querystring.parse(parsedUrl.query);

  console.log("Request:", parsedUrl, queryParams);

  switch (parsedUrl.pathname) {
    case "/eventsFromGpt.html": {
      if (!queryParams.query) {
        throw "Missing query!";
      }
      const query = queryParams.query;
      const ideas = await gptListEvents(openai, gptThrottler, query);
      console.log("ideas:", ideas);
			await parallelEachI(ideas, async (ideaIndex, idea) => {
				const {name, city, state} = idea;
				const normalizedName = normalizeName(name, city, state);
				idea.normalizedName = normalizedName;
		  	const maybeSimilarSubmission = await db.getSimilarEvent(normalizedName);
		  	if (maybeSimilarSubmission) {
		  		const {name: similarIdeaName, city: similarIdeaCity, state: similarIdeaState} =
		  				maybeSimilarSubmission;
				  if (idea.city == similarIdeaCity &&
				  		normalizeState(idea.state) == normalizeState(similarIdeaState)) {
				  	idea.notes = "(Already known)";
				  } else {
			  		idea.notes = "(Similar known: " + similarIdeaName + " in " + similarIdeaCity + ", " + similarIdeaState + ")";
			  	}
			  } else {
			  	idea.notes = "";
			  	// Do nothing
			  }
			});
			ideas.sort((a, b) => {
				if (a.notes.length != b.notes.length) {
					return a.notes.length - b.notes.length;
				}
				return a.name.localeCompare(b.name);
			});

      const pageHtml = await fs.readFile("eventsFromGpt.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { ideas, query });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/unconsidered.html": {
      const submissions = await db.getCreatedSubmissions();

			await parallelEachI(submissions, async (submissionIndex, submission) => {
				const {name, city, state} = submission;
				const normalizedName = normalizeName(name, city, state);
				submission.normalizedName = normalizedName;
				console.log("looking for similars to ", submission);
		  	const maybeSimilarSubmission = await db.getSimilarEvent(normalizedName);
		  	console.log("submission:", submission, "maybe similar:", maybeSimilarSubmission);
		  	if (maybeSimilarSubmission) {
		  		const {name: similarSubmissionName, city: similarSubmissionCity, state: similarSubmissionState} =
		  				maybeSimilarSubmission;
				  if (submission.city == similarSubmissionCity &&
				  		normalizeState(submission.state) == normalizeState(similarSubmissionState)) {
				  	submission.notes = "(Already known)";
				  } else {
			  		submission.notes = "(Similar known: " + similarSubmissionName + " in " + similarSubmissionCity + ", " + similarSubmissionState + ")";
			  	}
			  } else {
			  	submission.notes = "";
			  	// Do nothing
			  }
			});
			submissions.sort((a, b) => {
				if (a.notes.length != b.notes.length) {
					return a.notes.length - b.notes.length;
				}
				return a.name.localeCompare(b.name);
			});

      const pageHtml = await fs.readFile("unconsidered.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { submissions: submissions });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/confirmed.html": {
      const events = await db.getAnalyzedEents();
      await parallelEachI(events, async (eventI, event) => {
	      event.confirmations = await db.getEventConfirmations(event.id);
      });
      const pageHtml = await fs.readFile("confirmed.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { events: events });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/askGpt.html": {
      res.write(await fs.readFile("askGpt.html", { encoding: 'utf8' }));
    } break;

    case "/submission": {
      const {submission_id: submissionId} = queryParams;
      if (submissionId == null) throw "Missing submission_id!";

      const submission = await db.getSubmission(submissionId);
      submission.investigation.analyses =
      		submission.investigation.confirms
      				.concat(submission.investigation.rejects);
      const event = await db.getSubmissionEvent(submissionId);
      console.log("event:", event);
      if (event) {
	      event.confirmations = await db.getEventConfirmations(event.id);
	    }

	    console.log("submission:", submission);

      const pageHtml = await fs.readFile("submission.html", { encoding: 'utf8' });
			const response = eta.renderString(pageHtml, { submission, event });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/submit": {
      const {name, city, state, description, url} = queryParams;
      if (name == null) throw "Missing name!";
      if (state == null) throw "Missing state!";
      if (city == null) throw "Missing city!";
      // url is optional
      if (description == null) throw "Missing description!";

      const success = await addSubmission(db, {name, city, state, description, url}, true);
      if (success) {
        res.writeHead(200);
      } else {
        res.writeHead(409);
        res.write("Event already exists.")
      }
    } break;

    case "/publish": {
      const {event_id: eventId} = queryParams;
      if (eventId == null) throw "Missing event_id!";

      await db.publishEvent(eventId);
    } break;

    case "/rejectEvent": {
      const {event_id: eventId} = queryParams;
      if (eventId == null) throw "Missing event_id!";

      await db.rejectEvent(eventId);
    } break;

    case "/approve": {
      const {submission_id: submissionId} = queryParams;
      if (submissionId == null) throw "Missing submission_id!";

      await db.approveSubmission(submissionId);
    } break;

    case "/reject": {
      const {submission_id: submissionId} = queryParams;
      if (submissionId == null) throw "Missing submission_id!";
      await db.rejectSubmission(submissionId);
    } break;

    default: {
      res.write("404");
    } break;
  }

  // End the response 
  console.log("Done!");
  res.end()
})

// Set up our server so it will listen on the port
server.listen(port, function (error) {
  // Checking any error occur while listening on port
  if (error) {
      console.log('Something went wrong', error);
  }
  // Else sent message of listening
  else {
      console.log('Server is listening on port ' + port);
  }
})
