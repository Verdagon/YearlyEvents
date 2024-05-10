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

      if (!normalizedName) {
        console.log("Skipping null name A");
        idea.similars = [];
      } else {
    		idea.similars = await this.db.getSimilarSubmissionsByName(normalizedName);
      }
    });

		// ideas.sort((a, b) => {
		// 	if (a.notes.length != b.notes.length) {
		// 		return a.notes.length - b.notes.length;
		// 	}
		// 	return a.name.localeCompare(b.name);
		// });

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
  		submission.similars = await this.db.getSimilarSubmissionsById(submission.submission_id);
      console.log("looking for similars to ", normalizeName, "got", submission.similars);
		});
    return submissions;
  }

  async confirmedSubmissions() {
    const events = await this.db.getConfirmedSubmissions();

    await parallelEachI(events, async (eventI, submission) => {
      const analyses = await this.db.getInvestigationAnalyses(submission.submission_id, 4);
      submission.confirmations = analyses;

      const similars = [];
      for (const otherName of distinct(analyses.map(row => row.analysis.name))) {
        if (!otherName) {
          console.log("Skipping null name A");
          continue;
        }
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

  // async scrutinies() {
  //   const events = await this.db.getUnresolvedDisagreements();

  //   await parallelEachI(events, async (eventI, submission) => {
  //     const analyses = await this.db.getInvestigationAnalyses(submission.submission_id, 'gpt-3.5-turbo');
  //     submission.confirmations = analyses;

  //     const similars = [];
  //     for (const otherName of distinct(analyses.map(row => row.analysis.name))) {
  //       if (!otherName) {
  //         console.log("Skipping null name A");
  //         continue;
  //       }
  //       for (const similar of await this.db.getSimilarSubmissionsByName(otherName)) {
  //         if (similar.submission_id != submission.submission_id) {
  //           similars.push(similar);
  //         }
  //       }
  //     }
  //     submission.similars = similars;
  //   });

  //   return events;
  // }

  async allFailed() {
    const submissions = await this.db.getFailedSubmissions();
    return submissions;
  }

  async failedNeedSubmissions() {
    const submissions = await this.db.getFailedNeedSubmissions();
    return submissions;
  }

  async failedNeedLeads() {
    return await this.db.getFailedNeedLeads();
  }

  async numApprovedSubmissions() {
    return await this.db.numApprovedSubmissions();
  }
  
  async numCreatedInvestigations() {
    return await this.db.numCreatedInvestigations();
  }
  
  async numCreatedPageLeads() {
    return await this.db.numCreatedPageLeads();
  }
  
  async numCreatedNameLeads() {
    return await this.db.numCreatedNameLeads();
  }

  async getPageText(url) {
    return await this.db.getPageText(url);
  }

	async submission(submissionId) {
    const lead = await this.db.getPageLead(submissionId);
    if (lead) {
      lead.pageAnalyses = await this.db.getPageAnalysesByUrl(lead.url);
    }

    const submission = await this.db.getSubmission(submissionId);
    let investigation = await this.db.getInvestigation(submissionId);
    if (investigation) {
    	investigation.analyses =
          await this.db.getInvestigationAnalyses(submissionId, 0);
      await parallelEachI(investigation.analyses, async (analysisI, analysis) => {
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
    }

    const pageHtml = await this.getResource("submission.html");
		const response = this.eta.renderString(pageHtml, { lead, submission, investigation });
    console.log("Response:", response);
    return response;
  }

  async submitLead(url, futureSubmissionStatus, futureSubmissionNeed) {
    return await this.db.transaction(async (trx) => {
      const maybeLead = await trx.getPageLeadByUrl(url);
      if (maybeLead) {
        return maybeLead.id;
      }
      const id = crypto.randomUUID();
      const steps = [];
      logs(steps)("Created lead", url, futureSubmissionStatus, "need:", futureSubmissionNeed);
      await trx.addPageLead(
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

  async restartWithUrl(submissionId, url) {
    await this.db.updateSubmissionUrl(submissionId, url);
    await this.db.updateSubmissionStatus(submissionId, 'approved');
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

  async broaden(submissionId) {
    return await this.db.transaction(async (trx) => {
      const submission = await trx.getSubmission(submissionId);
      if (submission == null) {
        throw "No submission with id " + submissionId;
      }
      const steps = [];
      const maybeLead = await trx.getNameLeadByName(submission.name);
      if (maybeLead) {
        await trx.burySubmission(submissionId);
        logs(steps)("Buried submission", submission.name);
        return maybeLead.id;
      }
      const leadId = submissionId;
      await trx.addNameLead(leadId, submission.name, 'created', steps);
      logs(steps)("Created name lead", submission.name);
      await trx.burySubmission(submissionId);
      logs(steps)("Buried submission", submission.name);
      return leadId;
    });    
  }
}
