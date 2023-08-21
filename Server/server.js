import fs from "fs/promises";
import knexBuilder from 'knex';
import url from "url";
import querystring from "querystring";
import { Configuration, OpenAIApi } from "openai";
import http from 'http';
import { gptListEvents}  from '../gptListEvents.js';
import { addEvent }  from '../addEvent.js';
import { addSubmission }  from '../addSubmission.js';
import { makeThrottler, Semaphore, delay } from "../utils.js"
import { Eta } from "eta";

const eta = new Eta();

const port = 8080

const knex = knexBuilder({
  client: 'sqlite3', // or 'better-sqlite3'
  connection: {
    filename: "../db.sqlite"
  },
  useNullAsDefault: true
});

const openAiApiKey = "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";

const configuration =
    new Configuration({
        organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
        apiKey: openAiApiKey,
    });
const openai = new OpenAIApi(configuration);

const gptThrottler = makeThrottler(120);
const chromeThrottler = new Semaphore(10);

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
      const events = await gptListEvents(openai, gptThrottler, queryParams.query);
      const pageHtml = await fs.readFile("eventsFromGpt.html", { encoding: 'utf8' });
      const response = eta.renderString(pageHtml, { events: events });
      console.log("Response:", response);
      res.write(response);
    } break;

    case "/askGpt.html": {
      res.write(await fs.readFile("askGpt.html", { encoding: 'utf8' }));
    } break;

    case "/submit": {
      const {name, city, state, description} = queryParams;
      if (name == null) throw "Missing name!";
      if (state == null) throw "Missing state!";
      if (city == null) throw "Missing city!";
      if (description == null) throw "Missing description!";
      res.write(await addSubmission(knex, {name, city, state, description}));
    } break;

    default: res.write("404"); break;
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
      console.log('Server is listening on port' + port);
  }
})
