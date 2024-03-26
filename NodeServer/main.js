import syncFs from "fs";
import fs from "fs/promises";
import url from "url";
import querystring from "querystring";
import http from 'http';
import { normalizeName } from '../Common/utils.js'
import { LocalDb } from '../LocalDB/localdb.js'
import { addSubmission } from '../Common/addSubmission.js'
// import { approveSubmission, rejectSubmission }  from '../approveSubmission.js';
// import { getUnconsideredSubmissions }  from '../getUnconsideredSubmissions.js';
import { Semaphore, parallelEachI } from "../Common/parallel.js"
import { normalizeState } from "../Common/utils.js"
import { YearlyEventsServer } from '../Server/YearlyEventsServer.js';

function readPostData(request) {
	return new Promise((resolver, rejecter) => {
	  let body = '';
		request.on('data', (chunk) => {
		  body += chunk.toString();
		});
		request.on('end', () => {
		  resolver(body);
		});
		request.on('error', (error) => {
		  rejecter(error);
		});
	})
}

const port = 8337

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

const scratchDir = process.argv[4];
if (!scratchDir) {
  throw "Expected scratch path for third argument, but was missing.";
}
if (!syncFs.existsSync(scratchDir)) {
	console.log("Making scratch dir:", scratchDir);
  await syncFs.mkdirSync(scratchDir);
}

const resourcesDir = process.argv[5];
if (!resourcesDir) {
  throw "Expected resources path for fourth argument, but was missing.";
}
if (!syncFs.existsSync(resourcesDir)) {
	throw "Expected resources path for fourth argument, but that path doesnt exist.";
}


const db = new LocalDb(null, dbPath);

const server = new YearlyEventsServer(scratchDir, db, openAiApiKey, async (file) => {
	return await fs.readFile(resourcesDir + "/" + file, { encoding: 'utf8' });
});

const nodeServer = http.createServer(async function(req, res) {
  const parsedUrl = url.parse(req.url);
  const queryParams = querystring.parse(parsedUrl.query);

  console.log("Request:", parsedUrl, queryParams);

  try {
	  switch (parsedUrl.pathname) {
	    case "/eventsFromGpt.html": {
	      const urlencodedBody = await readPostData(req);
	      if (!urlencodedBody) {
	      	throw "Invalid, no POST body!";
	      }
      	const body = querystring.parse(urlencodedBody);
	      if (!body) {
	      	throw "Invalid encoded body:" + urlencodedBody;
	      }
	      const seedState = body.seed_state;
	      // seedState is optional
	      const query = body.query;
	      if (!query) {
	        throw "Missing query!";
	      }
	      let conversation = null;
	      if (body.conversation) {
	      	conversation = JSON.parse(body.conversation);
	      	if (!conversation) {
	      		throw "Invalid conversation:" + parsed.conversation;
	      	}
	      }
	      console.log("Query:", query);
	      console.log("Conversation:", conversation);
	      const response = await server.eventsFromGpt(db, conversation, seedState, query);
	      console.log("Response:", response);
	      res.write(response);
	    } break;

	    case "/unconsidered.html": {
	      const response = await server.unconsidered();
	      console.log("Response:", response);
	      res.write(response);
	    } break;

	    case "/confirmed.html": {
	      const response = await server.confirmed();
	      console.log("Response:", response);
	      res.write(response);
	    } break;

	    case "/failed.html": {
	      const response = await server.failed();
	      console.log("Response:", response);
	      res.write(response);
	    } break;

	    case "/askGpt.html": {
	      res.write(await server.askGpt());
	    } break;

	    case "/submission": {
	      const {submission_id: submissionId} = queryParams;
	      if (submissionId == null) throw "Missing submission_id!";
	      const response = await server.submission(submissionId);
	      console.log("Response:", response);
	      res.write(response);
	    } break;

	    case "/submit": {
	      const {status, name, city, state, description, url, origin_query} = queryParams;
	      if (status == null) throw "Missing status!";
	      if (name == null) throw "Missing name!";
	      if (state == null) throw "Missing state!";
	      if (city == null) throw "Missing city!";
	      // url is optional
	      if (description == null) throw "Missing description!";
	      // origin_query is optional

	      const submissionId = await server.submit(status, name, city, state, description, url, origin_query);
	      if (submissionId) {
	        res.writeHead(200);
	        res.write(submissionId)
	      } else {
	        res.writeHead(409);
	        res.write("Event already exists.")
	      }
	    } break;

	    case "/publish": {
	      const {event_id: eventId} = queryParams;
	      if (eventId == null) throw "Missing event_id!";

	      await server.publish(eventId);
	    } break;

	    case "/rejectEvent": {
	      const {event_id: eventId} = queryParams;
	      if (eventId == null) throw "Missing event_id!";

	      await server.rejectEvent(eventId);
	    } break;

	    case "/approve": {
	      const {submission_id: submissionId} = queryParams;
	      if (submissionId == null) throw "Missing submission_id!";

	      await server.approve(submissionId);
	    } break;

	    case "/reject": {
	      const {submission_id: submissionId} = queryParams;
	      if (submissionId == null) throw "Missing submission_id!";
	      await server.reject(submissionId);
	    } break;

	    default: {
	      res.write("404");
	    } break;
	  }

	  // End the response 
	  console.log("Done!");
	  res.end()
	} catch (error) {
		console.log("Error:", error);
		try {
			res.writeHead(500);
			if (typeof error == 'string') {
				res.write(error);
			} else if (error.message) {
				res.write(error.message);
			} else {
				res.write(JSON.stringify(error));
			}
	  	res.end()
		} catch (error2) {
			console.log("Error while sending error response:", error2);
			res.write("Error while sending error response: " + error2);
	  	res.end()
		}
	}
})

// Set up our server so it will listen on the port
nodeServer.listen(port, function (error) {
  // Checking any error occur while listening on port
  if (error) {
      console.log('Something went wrong', error);
  }
  // Else sent message of listening
  else {
      console.log('Server is listening on port ' + port);
  }
})
