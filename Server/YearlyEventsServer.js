import { Configuration, OpenAIApi } from "openai";
import { Eta } from "eta";
import { gptListEvents}  from '../Common/gptListEvents.js';
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

	async eventsFromGpt(query) {
    const ideas = await gptListEvents(this.openai, this.gptThrottler, query);
    console.log("ideas:", ideas);
		await parallelEachI(ideas, async (ideaIndex, idea) => {
			const {name, city, state} = idea;
			const normalizedName = normalizeName(name, city, state);
			idea.normalizedName = normalizedName;
	  	const maybeSimilarSubmission = await this.db.getSimilarEvent(normalizedName);
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

    const pageHtml = await this.getResource("eventsFromGpt.html");
    const response = this.eta.renderString(pageHtml, { ideas, query });
    return response;
  }

  async unconsidered() {
    const submissions = await this.db.getCreatedSubmissions();

		await parallelEachI(submissions, async (submissionIndex, submission) => {
			const {name, city, state} = submission;
			const normalizedName = normalizeName(name, city, state);
			submission.normalizedName = normalizedName;
			console.log("looking for similars to ", submission);
	  	const maybeSimilarSubmission = await this.db.getSimilarEvent(normalizedName);
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

    const pageHtml = this.getResource("unconsidered.html");
    return this.eta.renderString(pageHtml, { submissions: submissions });
  }

  async confirmed() {
    const events = await this.db.getAnalyzedEents();
    await parallelEachI(events, async (eventI, event) => {
      event.confirmations = await this.db.getEventConfirmations(event.id);
    });
    const pageHtml = this.getResource("confirmed.html");
    const response = this.eta.renderString(pageHtml, { events: events });
    return response;
  }

	async askGpt() {
		return this.getResource("askGpt.html");
	}

	async submission(submissionId) {
    const submission = await this.db.getSubmission(submissionId);
    submission.investigation.analyses =
    		submission.investigation.confirms
    				.concat(submission.investigation.rejects);
    const event = await this.db.getSubmissionEvent(submissionId);
    console.log("event:", event);
    if (event) {
      event.confirmations = await this.db.getEventConfirmations(event.id);
    }

    console.log("submission:", submission);

    const pageHtml = this.getResource("submission.html");
		const response = this.eta.renderString(pageHtml, { submission, event });
    console.log("Response:", response);
    return response;
  }

  async submit(name, city, state, description, url) {
    return await addSubmission(this.db, {name, city, state, description, url}, true);
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
