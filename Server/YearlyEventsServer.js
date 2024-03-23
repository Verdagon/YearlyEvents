import syncFs from "fs";
import fs from "fs/promises";
import url from "url";
import querystring from "querystring";
import { Configuration, OpenAIApi } from "openai";
import { gptListEvents}  from '../gptListEvents.js';
import { normalizeName } from '../utils.js'
import { addSubmission } from '../addSubmission.js'
// import { approveSubmission, rejectSubmission }  from '../approveSubmission.js';
// import { getUnconsideredSubmissions }  from '../getUnconsideredSubmissions.js';
import { Semaphore, parallelEachI } from "../parallel.js"
import { Eta } from "eta";
import { normalizeState } from "../utils.js"

const eta = new Eta();

export class YearlyEventsServer {
	constructor(resourcesDir, scratchDir, db, openAiApiKey) {
		this.resourcesDir = resourcesDir;
		
		this.scratchDir = scratchDir;
		if (!syncFs.existsSync(this.scratchDir)) {
			console.log("Making scratch dir:", this.scratchDir);
		  syncFs.mkdirSync(this.scratchDir);
		}

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

    const pageHtml = await fs.readFile(this.resourcesDir + "/eventsFromGpt.html", { encoding: 'utf8' });
    const response = eta.renderString(pageHtml, { ideas, query });
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

    const pageHtml = await fs.readFile(this.resourcesDir + "/unconsidered.html", { encoding: 'utf8' });
    return eta.renderString(pageHtml, { submissions: submissions });
  }

  async confirmed() {
    const events = await this.db.getAnalyzedEents();
    await parallelEachI(events, async (eventI, event) => {
      event.confirmations = await this.db.getEventConfirmations(event.id);
    });
    const pageHtml = await fs.readFile(this.resourcesDir + "/confirmed.html", { encoding: 'utf8' });
    const response = eta.renderString(pageHtml, { events: events });
    return response;
  }

	async askGpt() {
		return await fs.readFile(this.resourcesDir + "/askGpt.html", { encoding: 'utf8' });
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

    const pageHtml = await fs.readFile(this.resourcesDir + "/submission.html", { encoding: 'utf8' });
		const response = eta.renderString(pageHtml, { submission, event });
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
