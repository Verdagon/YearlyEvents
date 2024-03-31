import { Configuration, OpenAIApi } from "openai";
import { Eta } from "eta";
import { logs, normalizeName, distinct } from "../Common/utils.js";
import { gptListEvents, makeNewConversation, continuedConversation }  from '../Common/gptListEvents.js';
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

		this.llmRequester = new Semaphore(null, 120);
	}

	async eventsFromGpt(db, pastConversation, seedState, query) {
		console.log("received past conversation:", pastConversation);
		const conversation =
				pastConversation == null ?
						await makeNewConversation(db, query, seedState) :
						continuedConversation(pastConversation);
    const ideas = await gptListEvents(this.openai, this.llmRequester, conversation);
		await parallelEachI(ideas, async (ideaIndex, idea) => {
			const {name, city, state} = idea;
			const normalizedName = normalizeName(name, city, state);
			idea.normalizedName = normalizedName;

			idea.notes = "";

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
    });

		ideas.sort((a, b) => {
			if (a.notes.length != b.notes.length) {
				return a.notes.length - b.notes.length;
			}
			return a.name.localeCompare(b.name);
		});

		const conversationJsonStr = JSON.stringify(conversation);

    const pageHtml = await this.getResource("eventsFromGpt.html");
    const response =
        this.eta.renderString(
            pageHtml,
            { ideas, query, conversation: conversationJsonStr, seedState });
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

  async confirmedSubmissions() {
    const events = await this.db.getConfirmedSubmissions();

    await parallelEachI(events, async (eventI, submission) => {
      submission.notes = "";

      const analyses = await this.db.getInvestigationAnalyses(submission.submission_id, 'gpt-3.5-turbo');
      submission.confirmations = analyses;

      const similars = [];
      for (const otherName of distinct(analyses.map(row => row.analysis.name))) {
        for (const similar of await this.db.getSimilarSubmissionsByName(otherName)) {
          if (similar.submission_id != submission.submission_id) {
            similars.push(similar);
          }
        }
      }
      submission.similars = similars;
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
    if (lead) {
      lead.pageAnalyses = await this.db.getPageAnalysesByUrl(lead.url);
    }

    const submission = await this.db.getSubmission(submissionId);
    if (submission) {
      submission.investigations = [];
      for (const investigation of await this.db.getInvestigations(submissionId)) {
      	investigation.pageAnalyses =
            await this.db.getInvestigationAnalyses(submissionId, investigation.model);
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

    const pageHtml = await this.getResource("submission.html");
		const response = this.eta.renderString(pageHtml, { lead, submission });
    console.log("Response:", response);
    return response;
  }

  async submitLead(url, futureSubmissionStatus, futureSubmissionNeed) {
    return await this.db.transaction(async (trx) => {
      const maybeLead = await trx.getLeadByUrl(url);
      if (maybeLead) {
        return maybeLead.id;
      }
      const id = crypto.randomUUID();
      const steps = [];
      logs(steps)("Created lead", url, futureSubmissionStatus, "need:", futureSubmissionNeed);
      await trx.addLead(
          id, url, 'created', steps, futureSubmissionStatus, futureSubmissionNeed);
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

  async publish(eventId, bestName, bestUrl) {
    await this.db.publishSubmission(eventId, bestName, bestUrl);
  }

  // async rejectEvent(eventId) {
  //   await this.db.rejectEvent(eventId);
  // }

  async approve(submissionId, need) {
    await this.db.approveSubmission(submissionId, need);
  }

  async markDuplicate(duplicateSubmissionId, mainSubmissionId) {
    return await this.db.transaction(async (trx) => {
      await trx.markDuplicate(duplicateSubmissionId, mainSubmissionId);
    });
  }

  async reject(submissionId) {
    await this.db.rejectSubmission(submissionId);
  }

  async bury(submissionId) {
    await this.db.burySubmission(submissionId);
  }
}
