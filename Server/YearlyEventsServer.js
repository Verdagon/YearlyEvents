import { Configuration, OpenAIApi } from "openai";
import { Eta } from "eta";
import { gptListEvents, makeNewConversation, continuedConversation }  from '../Common/gptListEvents.js';
import { normalizeName } from '../Common/utils.js'
import { addSubmission } from '../Common/addSubmission.js'
import { Semaphore, parallelEachI } from "../Common/parallel.js"
import { normalizeState } from "../Common/utils.js"

export class YearlyEventsServer {
	constructor(scratchDir, db, openAiApiKey, getResource) {
		this.eta = new Eta();

		this.getResource = getResource;
		
		this.scratchDir = scratchDir;

		this.db = db;

		const configuration =
		    new Configuration({
		        organization: "org-EbC0AlrlKKVlmz1Btm3zyAPj",
		        apiKey: openAiApiKey,
		    });
		this.openai = new OpenAIApi(configuration);

		this.gptThrottler = new Semaphore(null, 120);
	}

	async eventsFromGpt(db, pastConversation, seedState, query) {
		console.log("received past conversation:", pastConversation);
		const conversation =
				pastConversation == null ?
						await makeNewConversation(db, query, seedState) :
						continuedConversation(pastConversation);
    const ideas = await gptListEvents(this.openai, this.gptThrottler, conversation);
		await parallelEachI(ideas, async (ideaIndex, idea) => {
			const {name, city, state} = idea;
			const normalizedName = normalizeName(name, city, state);
			idea.normalizedName = normalizedName;

			idea.notes = "";

	  	const maybeSimilarEvent = await this.db.getSimilarNonRejectedEvent(normalizedName);

	  	if (maybeSimilarEvent) {
	  		const {name: similarEventName, city: similarEventCity, state: similarEventState} =
	  				maybeSimilarEvent;
			  if (idea.city == similarEventCity &&
			  		normalizeState(idea.state) == normalizeState(similarEventState)) {
			  	idea.notes = "(Already known " + maybeSimilarEvent.status + " event)";
			  } else {
		  		idea.notes = "(Similar known " + maybeSimilarEvent.status + " event: " + similarEventName + " in " + similarEventCity + ", " + similarEventState + ")";
		  	}
		  } else {
	  		const maybeSimilarSubmission = await this.db.getSimilarSubmission(normalizedName);
		  	if (maybeSimilarSubmission) {
		  		const {name: similarSubmissionName, city: similarSubmissionCity, state: similarSubmissionState} =
		  				maybeSimilarSubmission;
				  if (idea.city == similarSubmissionCity &&
				  		normalizeState(idea.state) == normalizeState(similarSubmissionState)) {
				  	idea.notes = "(Already known " + maybeSimilarSubmission.status + " submission)";
				  } else {
			  		idea.notes = "(Similar known " + maybeSimilarSubmission.status + " submission: " + similarSubmissionName + " in " + similarSubmissionCity + ", " + similarSubmissionState + ")";
			  	}
			  } else {
			  	// Do nothing
			  }
		  }

		});
		ideas.sort((a, b) => {
			if (a.notes.length != b.notes.length) {
				return a.notes.length - b.notes.length;
			}
			return a.name.localeCompare(b.name);
		});

		const conversationJsonStr = JSON.stringify(conversation);

    const pageHtml = await this.getResource("eventsFromGpt.html");
    const response = this.eta.renderString(pageHtml, { ideas, query, conversation: conversationJsonStr, seedState });
    return response;
  }

  async unconsidered() {
    const submissions = await this.db.getCreatedSubmissions();

		await parallelEachI(submissions, async (submissionIndex, submission) => {
			const {name, city, state} = submission;
			const normalizedName = normalizeName(name, city, state);
			submission.normalizedName = normalizedName;
			submission.notes = "";
			console.log("looking for similars to ", submission);
	  	const maybeSimilarEvent = await this.db.getSimilarNonRejectedEvent(normalizedName);
	  	console.log("submission:", submission, "maybe similar:", maybeSimilarEvent);
	  	if (maybeSimilarEvent) {
	  		const {name: similarEventName, city: similarEventCity, state: similarEventState} =
	  				maybeSimilarEvent;
			  if (submission.city == similarEventCity &&
			  		normalizeState(submission.state) == normalizeState(similarEventState)) {
			  	submission.notes = "(Already known " + maybeSimilarEvent.status + " event)";
			  } else {
		  		submission.notes = "(Similar known " + maybeSimilarEvent.status + " event: " + similarEventName + " in " + similarEventCity + ", " + similarEventState + ")";
		  	}
		  } else {
	  		const maybeSimilarSubmission = await this.db.getSimilarSubmission(normalizedName);
		  	if (maybeSimilarSubmission) {
		  		const {name: similarSubmissionName, city: similarSubmissionCity, state: similarSubmissionState} =
		  				maybeSimilarSubmission;
				  if (submission.city == similarSubmissionCity &&
				  		normalizeState(submission.state) == normalizeState(similarSubmissionState)) {
				  	submission.notes = "(Already known " + maybeSimilarSubmission.status + " submission)";
				  } else {
			  		submission.notes = "(Similar known " + maybeSimilarSubmission.status + " submission: " + similarSubmissionName + " in " + similarSubmissionCity + ", " + similarSubmissionState + ")";
			  	}
			  } else {
			  	// Do nothing
			  }
		  }
		});
		submissions.sort((a, b) => {
			if (a.notes.length != b.notes.length) {
				return a.notes.length - b.notes.length;
			}
			return a.name.localeCompare(b.name);
		});

    const pageHtml = await this.getResource("unconsidered.html");
    return this.eta.renderString(pageHtml, { submissions: submissions });
  }

  async confirmed() {
    const events = await this.db.getAnalyzedEvents();
    await parallelEachI(events, async (eventI, event) => {
      event.confirmations = await this.db.getEventConfirmations(event.id);
    });
    const pageHtml = await this.getResource("confirmed.html");
    const response = this.eta.renderString(pageHtml, { events: events });
    return response;
  }

  async failed() {
    const submissions = await this.db.getFailedSubmissions();
    submissions.forEach((submission) => {
    	submission.notes = "";
    })
    const pageHtml = await this.getResource("failed.html");
    const response = this.eta.renderString(pageHtml, { submissions: submissions });
    return response;
  }

	async askGpt() {
		console.log("getting thing");
		const x = await this.getResource("askGpt.html");
		console.log("got thing");
		return x;
	}

	async submission(submissionId) {
    const submission = await this.db.getSubmission(submissionId);

		let analyses = [];
    if (submission.investigation) {
	    analyses =
	    		submission.investigation.confirms.map(confirm => {
	    			const result = JSON.parse(JSON.stringify(confirm));
	    			result.conclusion = "confirmed";
	    			return result;
	    		})
	    		.concat(submission.investigation.rejects.map(reject => {
	    			const result = JSON.parse(JSON.stringify(reject));
	    			result.conclusion = "rejected";
	    			return result;
	    		}));
	  }

    const event = await this.db.getSubmissionEvent(submissionId);
    if (event) {
      event.confirmations = await this.db.getEventConfirmations(event.id);
    }

    const pageHtml = await this.getResource("submission.html");
		const response = this.eta.renderString(pageHtml, { submission, event, analyses });
    console.log("Response:", response);
    return response;
  }

  async submit(status, name, city, state, description, url, origin_query) {
    return await addSubmission(this.db, {status, name, city, state, description, url, origin_query});
  }

  async publish(eventId) {
    await this.db.publishEvent(eventId);
  }

  async rejectEvent(eventId) {
    await this.db.rejectEvent(eventId);
  }

  async approve(submissionId) {
    await this.db.approveSubmission(submissionId);
  }

  async reject(submissionId) {
    await this.db.rejectSubmission(submissionId);
  }
}
