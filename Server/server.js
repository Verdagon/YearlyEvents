import fs from "fs/promises";
import knexBuilder from 'knex';
import url from "url";
import querystring from "querystring";
import { Configuration, OpenAIApi } from "openai";
import http from 'http';
import { connectKnex } from '../db.js'
import { gptListEvents}  from '../gptListEvents.js';
import { addEvent }  from '../addEvent.js';
import { normalizeName } from '../utils.js'
import { addSubmission, getSimilarSubmission }  from '../addSubmission.js';
import { approveSubmission, rejectSubmission }  from '../approveSubmission.js';
// import { getUnconsideredSubmissions }  from '../getUnconsideredSubmissions.js';
import { Semaphore, parallelEachI } from "../parallel.js"
import { Eta } from "eta";
import { abbreviateState } from "../utils.js"

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

const knex = connectKnex(dbPath);

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
		  	const maybeSimilarSubmission = await getSimilarSubmission(knex, name, city, state);
		  	if (maybeSimilarSubmission) {
		  		const {name: similarideaName, city: similarideaCity, state: similarideastate} =
		  				maybeSimilarSubmission;

		  		console.log(
		  				"Checking similar:",
		  				idea.city,
		  				idea.state,
		  				similarideaCity,
		  				similarideastate,
		  				abbreviateState(idea.state),
		  				abbreviateState(similarideastate));
				  if (idea.city == similarideaCity &&
				  		abbreviateState(idea.state) == abbreviateState(similarideastate)) {
				  	idea.notes = "(Already known)";
				  } else {
			  		idea.notes = "(Similar known: " + name + " in " + city + ", " + state + ")";
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
      const submissions =
      		await knex.select().from("Submissions").where({status: "created"});
      const pageHtml = await fs.readFile("unconsidered.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { submissions: submissions });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/confirmed.html": {
      const events =
      		await knex.select().from("ConfirmedEvents").where({status: "analyzed"});
      await parallelEachI(events, async (eventI, event) => {
    		const confirmations =
	      		await knex.select().from("EventConfirmations").where({event_id: event.id});
	      event.confirmations = confirmations;
      });
      const pageHtml = await fs.readFile("confirmed.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { events: events });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/askGpt.html": {
      res.write(await fs.readFile("askGpt.html", { encoding: 'utf8' }));
    } break;

    case "/submit": {
      const {name, city, state, description, url} = queryParams;
      if (name == null) throw "Missing name!";
      if (state == null) throw "Missing state!";
      if (city == null) throw "Missing city!";
      // url is optional
      if (description == null) throw "Missing description!";

      const success = addSubmission(knex, {name, city, state, description, url}, true);
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

      await knex("ConfirmedEvents").where({'id': eventId}).update({
				'status': 'published'
			});
    } break;

    case "/reject_event": {
      const {event_id: eventId} = queryParams;
      if (eventId == null) throw "Missing event_id!";

      await knex("ConfirmedEvents").where({'id': eventId}).update({
				'status': 'rejected'
			});
    } break;

    case "/approve": {
      const {submission_id: submissionId} = queryParams;
      if (submissionId == null) throw "Missing submission_id!";

      await knex("Submissions").where({'submission_id': submissionId}).update({
				'status': 'approved'
			});
    } break;

    case "/reject": {
      const {submission_id: submissionId} = queryParams;
      if (submissionId == null) throw "Missing submission_id!";
      await knex("Submissions").where({'submission_id': submissionId}).update({
				'status': 'rejected'
			});
    } break;

    default: {
      res.write("404");
    } break;
  }

  // console.log(await knex.select('id', 'name').from('Events'));

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
