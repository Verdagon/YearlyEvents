import fs from "fs/promises";
import knexBuilder from 'knex';
import url from "url";
import querystring from "querystring";
import { Configuration, OpenAIApi } from "openai";
import http from 'http';
import { connectKnex } from '../db.js'
import { gptListEvents}  from '../gptListEvents.js';
import { addEvent }  from '../addEvent.js';
import { addSubmission, getSimilarSubmission }  from '../addSubmission.js';
import { approveSubmission, rejectSubmission }  from '../approveSubmission.js';
// import { getUnconsideredSubmissions }  from '../getUnconsideredSubmissions.js';
import { Semaphore, parallelEachI } from "../parallel.js"
import { Eta } from "eta";

function abbreviateState(stateName) {
    const stateAbbreviations = {
        'Alabama': 'AL',
        'Alaska': 'AK',
        'Arizona': 'AZ',
        'Arkansas': 'AR',
        'California': 'CA',
        'Colorado': 'CO',
        'Connecticut': 'CT',
        'Delaware': 'DE',
        'Florida': 'FL',
        'Georgia': 'GA',
        'Hawaii': 'HI',
        'Idaho': 'ID',
        'Illinois': 'IL',
        'Indiana': 'IN',
        'Iowa': 'IA',
        'Kansas': 'KS',
        'Kentucky': 'KY',
        'Louisiana': 'LA',
        'Maine': 'ME',
        'Maryland': 'MD',
        'Massachusetts': 'MA',
        'Michigan': 'MI',
        'Minnesota': 'MN',
        'Mississippi': 'MS',
        'Missouri': 'MO',
        'Montana': 'MT',
        'Nebraska': 'NE',
        'Nevada': 'NV',
        'New Hampshire': 'NH',
        'New Jersey': 'NJ',
        'New Mexico': 'NM',
        'New York': 'NY',
        'North Carolina': 'NC',
        'North Dakota': 'ND',
        'Ohio': 'OH',
        'Oklahoma': 'OK',
        'Oregon': 'OR',
        'Pennsylvania': 'PA',
        'Rhode Island': 'RI',
        'South Carolina': 'SC',
        'South Dakota': 'SD',
        'Tennessee': 'TN',
        'Texas': 'TX',
        'Utah': 'UT',
        'Vermont': 'VT',
        'Virginia': 'VA',
        'Washington': 'WA',
        'West Virginia': 'WV',
        'Wisconsin': 'WI',
        'Wyoming': 'WY'
    };
    
    const abbreviation = stateAbbreviations[stateName];
    return abbreviation || stateName;
}

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
      const submissions = await gptListEvents(openai, gptThrottler, queryParams.query);
      console.log("submissions:", submissions);
			await parallelEachI(submissions, async (submissionIndex, submission) => {
				const {name, city, state} = submission;
		  	const similar = await getSimilarSubmission(knex, name, city, state);
		  	if (similar) {
		  		const {name: similarSubmissionName, city: similarSubmissionCity, state: similarSubmissionState} =
		  				similar;

		  		console.log("Checking similar:", submission.city, submission.state, similarSubmissionCity, similarSubmissionState, abbreviateState(submission.state), abbreviateState(similarSubmissionState));
				  if (submission.city == similarSubmissionCity &&
				  		abbreviateState(submission.state) == abbreviateState(similarSubmissionState)) {
				  	submission.notes = "(Already known)";
				  } else {
			  		submission.notes = "(Similar known: " + name + " in " + city + ", " + state + ")";
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

      const pageHtml = await fs.readFile("eventsFromGpt.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { events: submissions });
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
