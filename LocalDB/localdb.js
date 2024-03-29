import knexBuilder from 'knex';
import { parallelEachI } from "../Common/parallel.js";
import { normalizeName, normalizeState, normalizePlace } from "../Common/utils.js";

export class LocalDb {
	constructor(dbThrottler, parent, dbPath) {
    this.dbThrottler = dbThrottler;
		if (parent) {
			this.knex = null;
			this.target = parent;
		} else {
			this.knex =
					knexBuilder({
				    client: 'sqlite3', // or 'better-sqlite3'
				    connection: {
				      filename: dbPath
				    },
				    useNullAsDefault: true
				  });
			this.target = this.knex;
		}
	}

	destroy() {
		if (this.knex) {
			this.knex.destroy();
		}
	}

	async transaction(inner) {
		if (this.knex == null) {
			throw "Already in transaction!";
		}
    return await this.dbThrottler.do(async () => {
  		return await this.knex.transaction(async (trx) => {
  			return await inner(new LocalDb(this.dbThrottler, trx, null));
  		});
    });
	}

  async maybeThrottle(inner) {
    if (this.knex == null) {
      // Then we're already in a transaction, so just call it.
      return await inner();
    } else {
      return await this.dbThrottler.do(inner);
    }
  }

	async getSimilarNonRejectedEvent(normalizedName) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target).select().from("ConfirmedEvents")
  				// ConfirmedEvents name is always normalized
  	    			.where({name: normalizedName})
  	    			.whereNot({status: 'rejected'});
  	  return results[0] || null;
    });
	}

	async getSimilarSubmission(normalizedName) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target).select().from("Submissions")
  	    			.where({name: normalizedName});
  	  return results[0] || null;
    });
	}

	async getSimilarSubmissionById(id) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target)
  						.from("Submissions as s1")
  						.select("s2.*")
  						.where("s1.submission_id", id)
  				    .join("Submissions as s2", function() {
  				        this.on("s1.name", "=", "s2.name")
  				            .andOn("s1.submission_id", "!=", "s2.submission_id");
  				    });
  	  return results[0] || null;
    });
	}

	async getSimilarPublishedEventById(id) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target)
  						.from("ConfirmedEvents as e1")
  						.select("e2.*")
  						.where("e1.id", id)
  						.where("e2.status", "published")
  				    .join("ConfirmedEvents as e2", function() {
  				        this.on("e1.name", "=", "e2.name")
  				            .andOn("e1.id", "!=", "e2.id");
  				    });
      console.log("similar results:", results);
  	  return results[0] || null;
    });
	}

	async getExistingSubmission(normalizedName, city, state) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target).select().from("Submissions")
  	    			.where({name: normalizedName, city, state});
  	  return results[0] || null;
    });
	}

	async insertSubmission(row) {
    return await this.maybeThrottle(async () => {
      console.assert(row.name == normalizeName(row.name, row.city, row.state));
      console.assert(row.state == normalizeState(row.state));
      console.assert(row.city == normalizePlace(row.city));
  		await (this.target).into("Submissions")
          .insert(row)
          .onConflict(['name', 'state', 'city']).ignore();;
    });
	}


	async approveSubmission(submissionId, need) {
    return await this.maybeThrottle(async () => {
  		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
  			'status': 'approved',
        'need': need
  		});
    });
	}

	async rejectSubmission(submissionId) {
    return await this.maybeThrottle(async () => {
  		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
  			'status': 'rejected'
  		});
    });
	}

  async burySubmission(submissionId) {
    return await this.maybeThrottle(async () => {
      await (this.target)("Submissions").where({'submission_id': submissionId}).update({
        'status': 'buried'
      });
    });
  }

	async getApprovedSubmissions(trx) {
    return await this.maybeThrottle(async () => {
  		return await (this.target).select().from("Submissions")
  	      .whereNotNull("name")
  	      .whereNotNull("state")
  	      .whereNotNull("city")
  	      .where({status: 'approved'});
    });
	}

	async cachePageText(row) {
    return await this.maybeThrottle(async () => {
  		await (this.target).into("PageTextCache")
          .insert(row)
          .onConflict(['url']).merge();
    });
	}

  async getPageText(url) {
    return await this.maybeThrottle(async () => {
      const result = await (this.target).from("PageTextCache").select().where({url});
      return (result && result[0]) || null;
    });
  }

	async cachePageSummary(row) {
    return await this.maybeThrottle(async () => {
  		await (this.target).into("SummarizeCache")
          .insert(row)
          .onConflict(['url', 'prompt_version', 'model']).merge();
    });
	}

  async getCachedSummary(url, model, promptVersion) {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target).from("SummarizeCache").select()
              .where({url, model, prompt_version: promptVersion});
      return (result && result[0]) || null;
    });
  }

	async updateSubmissionStatus(submissionId, status) {
    return await this.maybeThrottle(async () => {
  		await (this.target)("Submissions")
          .where({'submission_id': submissionId})
  				.update({ status: status });
    });
	}

  async startInvestigation(submissionId, model) {
    return await this.maybeThrottle(async () => {
      // Do this in a transaction so we can detect any conflicts here
      await (this.target).into("Investigations")
          .insert({
            submission_id: submissionId,
            status: 'created',
            model: model,
            steps: null,
            investigation: null
          });
    });
  }

  async getInvestigation(submissionId, model) {
    return await this.maybeThrottle(async () => {
      const row =
          (await (this.target).select().from("Investigations")
              .where({submission_id: submissionId, model}))
              .map(row => {
                if (row.steps) {
                  row.steps = JSON.parse(row.steps);
                }
                return row;
              });
      return row && row[0] || null;
    });
  }

  async finishInvestigation(submissionId, model, status, investigation, steps) {
    return await this.maybeThrottle(async () => {
      await (this.target)("Investigations")
          .where({submission_id: submissionId, model: model})
          .update({
            status: status,
            steps: JSON.stringify(steps),
            investigation: JSON.stringify(investigation)
          });
    });
  }

  async getInvestigationPageAnalyses(submissionId, model) {
    return await this.maybeThrottle(async () => {
      return (await (this.target).select().from("PageAnalyses")
          .where({submission_id: submissionId, model}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
    });
  }

  async getPageAnalysis(submissionId, url, model) {
    return await this.maybeThrottle(async () => {
      const row =
          (await (this.target).select().from("PageAnalyses")
              .where({submission_id: submissionId, url}))
              .map(row => {
                if (row.steps) {
                  row.steps = JSON.parse(row.steps);
                }
                return row;
              });
      return row && row[0] || null;
    });
  }

  async startPageAnalysis(submissionId, url, model) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("PageAnalyses")
          .insert({
            submission_id: submissionId,
            url: url,
            model,
            status: 'created'
          });
    });
  }

  async finishPageAnalysis(submissionId, url, model, status, steps, analysis) {
    return await this.maybeThrottle(async () => {
      await (this.target)("PageAnalyses")
          .where({
            submission_id: submissionId,
            url: url,
            model: model
          })
          .update({
            status: status,
            steps: JSON.stringify(steps),
            analysis: JSON.stringify(analysis)
          });
    });
  }

	async insertEvent(row) {
    return await this.maybeThrottle(async () => {
      console.assert(row.name == normalizeName(row.name, row.city, row.state));
      console.assert(row.state == normalizeState(row.state));
      console.assert(row.city == normalizePlace(row.city));
  		await (this.target).into("ConfirmedEvents")
          .insert(row);
    });
	}

	async insertConfirmation(row) {
    return await this.maybeThrottle(async () => {
  		await (this.target).into("EventConfirmations")
          .insert(row);
    });
	}

	async getCreatedSubmissions() {
    return await this.maybeThrottle(async () => {
  		return await (this.target).select().from("Submissions").where({status: "created"});
    });
	}

	async getAnalyzedEvents() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("ConfirmedEvents").where({status: "analyzed"});
    });
  }

  async getAnalysisQuestion(url, question, model, summarizePromptVersion) {
    return await this.maybeThrottle(async () => {
      const rows = (await (this.target).select()
          .from("AnalyzeCache")
          .where({
            url,
            question,
            model,
            summarize_prompt_version: summarizePromptVersion
          }))
          .map(row => {
            row.error = JSON.parse(row.error);
            return row;
          });
      return rows && rows[0];
    });
  }

  async createAnalysisQuestion(url, question, model, summarizePromptVersion) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("AnalyzeCache")
          .insert({
            url,
            question,
            model,
            summarize_prompt_version: summarizePromptVersion,
            status: 'created',
            answer: null,
            error: null
          })
          .onConflict(['url', 'question', 'model', 'summarize_prompt_version']).merge();
    });
  }

  async finishAnalysisQuestion(url, question, model, summarizePromptVersion, status, answer, errorText) {
    return await this.maybeThrottle(async () => {
      await (this.target)("AnalyzeCache")
          .where({
            url,
            question,
            model,
            summarize_prompt_version: summarizePromptVersion
          })
          .update({
            answer,
            status,
            error: JSON.stringify(errorText)
          });
    });
  }

  async getFailedSubmissions() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions").where({status: "failed"});
    });
  }

  async getFailedNeedSubmissions() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions")
          .whereNot('need', 0)
          .whereNot('status', "confirmed")
          .whereNot('status', "approved")
          .whereNot('status', "created")
          .whereNot('status', 'buried');
    });
  }

  async numApprovedSubmissions() {
    return await this.maybeThrottle(async () => {
      return (await (this.target)("Submissions")
          .count('submission_id as count')
          .where('status', 'approved'))
          .count;
    });
  }

  async getEventConfirmations(eventId) {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("EventConfirmations").where({event_id: eventId});
    });
  }

  async getSubmission(submissionId) {
    return await this.maybeThrottle(async () => {
      const rows = (await (this.target).select().from("Submissions").where({submission_id: submissionId}));
  		return rows[0] || null;
    });
  }

  async getInvestigations(submissionId) {
    return await this.maybeThrottle(async () => {
      return (await (this.target).select().from("Investigations")
          .where({submission_id: submissionId}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
    });
  }

  async getPageAnalyses(submissionId, model) {
    return await this.maybeThrottle(async () => {
      return (await (this.target).select().from("PageAnalyses").where({submission_id: submissionId, model: model}))
      		.map((row) => {
      			row.steps = JSON.parse(row.steps);
      			row.analysis = JSON.parse(row.analysis);
      			return row;
      		});
    });
  }

  async findApprovedSubmissionsAt(at, limit) {
    return await this.maybeThrottle(async () => {
    	return await (this.target).select().from("Submissions")
    			.where({status: 'approved', state: at})
    			.limit(limit);
    });
  }

  async getSubmissionEvent(submissionId) {
    return await this.maybeThrottle(async () => {
      const rows =
          await (this.target).select().from("ConfirmedEvents").where({submission_id: submissionId});
      return rows && rows[0] || null;
    });
  }

  async publishEvent(eventId, bestUrl) {
    return await this.maybeThrottle(async () => {
  	  await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
  			'status': 'published',
        'best_url': bestUrl
  		});
    });
	}

	async rejectEvent(eventId) {
    return await this.maybeThrottle(async () => {
      await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
  			'status': 'rejected'
  		});
    });
  }

	async cacheGoogleResult({query, response}) {
    return await this.maybeThrottle(async () => {
  		await (this.target).into("GoogleCache")
  				.insert({query, response: JSON.stringify(response)})
          .onConflict(['query']).merge();
    });
	}

  async getCachedGoogleResult(query) {
    return await this.maybeThrottle(async () => {
      const result =
          (await (this.target).from("GoogleCache").select().where({query}))
          .map(row => {
            if (row.response) {
              row.response = JSON.parse(row.response);
            }
            return row;
          });;
      return (result && result[0]) || null;
    });
  }
}
