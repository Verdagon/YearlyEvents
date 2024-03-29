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
	  		const maybeSimilarSubmission = await this.db.getSimilarSubmissionById(submission.submission_id);
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
    return submissions;
  }

  async confirmed() {
    const events = await this.db.getAnalyzedEvents();
    await parallelEachI(events, async (eventI, event) => {
      event.notes = "";

      const maybeSimilarEvent = await this.db.getSimilarPublishedEventById(event.id);
      if (maybeSimilarEvent) {
        const {name: similarEventName, city: similarEventCity, state: similarEventState} =
            maybeSimilarEvent;
        if (event.city == similarEventCity &&
            normalizeState(event.state) == normalizeState(similarEventState)) {
          event.notes = "(Already known " + maybeSimilarEvent.status + " event)";
        } else {
          event.notes = "(Similar known " + maybeSimilarEvent.status + " event: " + similarEventName + " in " + similarEventCity + ", " + similarEventState + ")";
        }
      } else {
        // Do nothing
      }
    });
    return events;
  }

  async allFailed() {
    const submissions = await this.db.getFailedSubmissions();
    submissions.forEach((submission) => {
    	submission.notes = "";
    })
    return submissions;
  }

  async failedNeedSubmissions() {
    const submissions = await this.db.getFailedNeedSubmissions();
    submissions.forEach((submission) => {
      submission.notes = "";
    })
    return submissions;
  }

  async numApprovedSubmissions() {
    return await this.db.numApprovedSubmissions();
  }
  
  async numCreatedInvestigations() {
    return await this.db.numCreatedInvestigations();
  }

	async submission(submissionId) {
    const lead = await this.db.getLead(submissionId);

    const submission = await this.db.getSubmission(submissionId);
    if (submission) {
      submission.investigations = [];
      for (const investigation of await this.db.getInvestigations(submissionId)) {
      	investigation.pageAnalyses =
            await this.db.getPageAnalyses(submissionId, investigation.model);
        await parallelEachI(investigation.pageAnalyses, async (analysisI, analysis) => {
          const pageTextRow = await this.db.getPageText(analysis.url);
          analysis.pageText = pageTextRow && pageTextRow.text;
          analysis.pageTextError = pageTextRow && pageTextRow.error;
          return pageTextRow;
        });
        investigation.steps = investigation.steps || investigation.broadSteps || investigation.broad_steps || [];
        if (!Array.isArray(investigation.steps)) {
          console.log("investigation steps isnt array?", JSON.stringify(investigation.steps));
          investigation.steps = [];
        }
      	submission.investigations.push(investigation);
      }
    }

    const event = await this.db.getSubmissionEvent(submissionId);

    const pageHtml = await this.getResource("submission.html");
		const response = this.eta.renderString(pageHtml, { lead, submission, event });
    console.log("Response:", response);
    return response;
  }

  async submitLead(url, status, need) {
    return this.db.transaction(async (trx) => {
      const maybeLead = await trx.getLead(url);
      if (maybeLead) {
        return maybeLead.id;
      }
      const id = crypto.randomUUID();
      await trx.addLead(id, url, status, need);
      return id;
    });
  }

  async submit(status, name, city, state, description, url, origin_query, need) {
    if (!name) {
      throw "Missing name!";
    }
    if (!city) {
      throw "Missing city!";
    }
    if (!state) {
      throw "Missing state!";
    }
    return await addSubmission(this.db, {status, name, city, state, description, url, origin_query, need});
  }

  async publish(eventId, bestUrl) {
    await this.db.publishEvent(eventId, bestUrl);
  }

  async rejectEvent(eventId) {
    await this.db.rejectEvent(eventId);
  }

  async approve(submissionId, need) {
    await this.db.approveSubmission(submissionId, need);
  }

  async reject(submissionId) {
    await this.db.rejectSubmission(submissionId);
  }

  async bury(submissionId) {
    await this.db.burySubmission(submissionId);
  }
}
