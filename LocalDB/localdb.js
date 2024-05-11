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

	async getSimilarSubmission(normalizedName) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target).select().from("Submissions")
  	    			.where({name: normalizedName});
  	  return results[0] || null;
    });
	}

  async getSimilarSubmissionsByName(name) {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions").where({name: name});
    });
  }

	async getSimilarSubmissionsById(id) {
    if (!id) {
      throw "getSimilarSubmissionById no ID";
    }
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
  	  return results || [];
    });
	}

	async getSimilarSubmissionByIdAndStatus(id, status) {
    return await this.maybeThrottle(async () => {
  		const results =
  				await (this.target)
  						.from("Submissions as e1")
  						.select("e2.*")
  						.where("e1.id", id)
  						.where("e2.status", status)
  				    .join("Submissions as e2", function() {
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
      if (row.city && row.state && row.name != normalizeName(row.name, row.city, row.state)) {
        throw "Name isnt normalized";
      }
      if (row.state && row.state != normalizeState(row.state)) {
        throw "State isnt normalized";
      }
      if (row.city && row.city != normalizePlace(row.city)) {
        throw "City isnt normalized";
      }
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

  async markDuplicate(submissionId, mainSubmissionId) {
    return await this.maybeThrottle(async () => {
      const submission = await this.getSubmission(submissionId);
      if (!submission) {
        throw "No submission for id: " + submissionId;
      }
      const mainSubmission = await this.getSubmission(mainSubmissionId);
      if (!mainSubmission) {
        throw "No submission for id: " + mainSubmission;
      }

      const oldStatus = submission.status;

      console.log("Marking duplicate submission as duplicate.");
      await (this.target)("Submissions").where({'submission_id': submissionId}).update({
        'status': 'duplicate',
        'better_submission_id': mainSubmissionId
      });

      for (const matchAnalysisRow of await this.getMatchAnalysesForSubmission(submissionId)) {
        const {submission_id, url, status, steps, matchness} = matchAnalysisRow;

        const matchAnalysisRowForMainSubmission =
            await this.getMatchAnalysis(mainSubmissionId, url);
        if (matchAnalysisRowForMainSubmission) {
          // Do nothing, trust what's already there
          console.log("Match analysis already exists for", submission_id, url);
        } else {
          // Make a new analysis for the main submission
          console.log("Making new", status, "match analysis for", submission_id, url);
          await this.startMatchAnalysis(mainSubmissionId, url);
          await this.finishMatchAnalysis(mainSubmissionId, url, status, steps, matchness);
        }
      }

      if (oldStatus == 'confirmed') {
        switch (mainSubmission.status) {
        case 'created':
        case 'failed':
        case 'approved':
          console.log("Updating main submission to confirmed.");
          await this.updateSubmissionStatus(mainSubmissionId, 'confirmed');
          break;
        }
      }
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

	async getProcessibleSubmissions(status, need, filterSubmissionId, scrutinize, retryErrors, limit) {
    return await this.maybeThrottle(async () => {
      let query = (this.target).select().from("Submissions").whereNotNull("name");
      if (status != null) {
        if (retryErrors) {
          query = query.where(function() {
            this.where({status}).orWhere({status: 'errors'});
          });
        } else {
          query = query.where({status});
        }
      }
      if (need != null) {
        query = query.where('need', '>=', need);
      }
      if (filterSubmissionId != null) {
        query = query.where('submission_id', filterSubmissionId);
      }
      if (scrutinize != null) {
        query = query.where('scrutinize', '=', scrutinize);
      }
      if (limit) {
        query = query.limit(limit);
      }
      console.log("q:", query.toString());
  		return await query;
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

  async getCachedPageSummary(url, model, promptVersion) {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target).from("SummarizeCache").select()
              .where({url, model, prompt_version: promptVersion});
      return (result && result[0]) || null;
    });
  }

  async cachePageCategory(row) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("CategoryCache")
          .insert(row)
          .onConflict(['url', 'prompt_version', 'model']).merge();
    });
  }

  async getCachedPageCategory(url, model, promptVersion) {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target).from("CategoryCache").select()
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

  // The url field is a hint about what url to try first for the event
  async updateSubmissionUrl(submissionId, url) {
    return await this.maybeThrottle(async () => {
      await (this.target)("Submissions")
          .where({'submission_id': submissionId})
          .update({ url: url });
    });
  }

  async startInvestigation(submissionId) {
    return await this.maybeThrottle(async () => {
      // Do this in a transaction so we can detect any conflicts here
      await (this.target).into("Investigations")
          .insert({
            submission_id: submissionId,
            status: 'created',
            steps: null,
            investigation: null
          });
    });
  }

  async getInvestigation(submissionId) {
    return await this.maybeThrottle(async () => {
      const row =
          (await (this.target).select().from("Investigations")
              .where({submission_id: submissionId}))
              .map(row => {
                if (row.steps) {
                  row.steps = JSON.parse(row.steps);
                }
                return row;
              });
      return row && row[0] || null;
    });
  }

  async finishInvestigation(submissionId, status, investigation, steps) {
    return await this.maybeThrottle(async () => {
      await (this.target)("Investigations")
          .where({submission_id: submissionId})
          .update({
            status: status,
            steps: JSON.stringify(steps),
            investigation: JSON.stringify(investigation)
          });
    });
  }

  async getInvestigationAnalyses(submissionId, minimumMatchness) {
    return await this.maybeThrottle(async () => {
      let query =
          (this.target)
            .select(
                "m.url as url",
                "submission_id",
                "m.steps as match_steps",
                "m.status as status",
                "m.matchness as matchness",
                "p.steps as page_steps",
                "p.analysis as analysis")
            .from("MatchAnalyses as m")
            .where({"m.submission_id": submissionId});
      if (minimumMatchness) {
        query = query.where('matchness', '>=', minimumMatchness);
      }
      query =
          query.join("PageAnalyses as p", function() {
            this.on("p.url", "=", "m.url");
          });
      console.log("getInvestigationAnalyses:", query.toString());
      return (await query)
          .map(row => {
            if (row.match_steps) {
              row.match_steps = JSON.parse(row.match_steps);
            }
            if (row.page_steps) {
              row.page_steps = JSON.parse(row.page_steps);
            }
            if (row.analysis) {
              row.analysis = JSON.parse(row.analysis);
            }
            return row;
          });
    });
  }

  async getPageLeadByUrl(url) {
    return await this.maybeThrottle(async () => {
      const rows =
          (await (this.target).select().from("PageLeads")
              .where({url}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
      return rows && rows[0] || null;
    });
  }

  async getPageLead(id) {
    return await this.maybeThrottle(async () => {
      const rows =
          (await (this.target).select().from("PageLeads")
              .where({id}))
            .map(row => {
              if (row.steps) {
                row.steps = JSON.parse(row.steps);
              }
              return row;
            });
      return rows && rows[0] || null;
    });
  }

  async addPageLead(id, url, status, steps, future_submission_status, future_submission_need) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("PageLeads")
          .insert({
            id,
            url,
            status,
            steps: JSON.stringify(steps),
            future_submission_status,
            future_submission_need
          });
    });
  }

  async updatePageLead(id, status, steps) {
    return await this.maybeThrottle(async () => {
      const updated =
          await (this.target)("PageLeads")
              .where({id})
              .update({
                status,
                steps: JSON.stringify(steps),
              });
      // console.log(updated + " rows updated by updatePageLead(" + id + ", " + status + ", ...)");
      if (!updated) {
        throw "No rows updated by updatePageLead(" + id + ", " + status + ", ...)";
      }
    });
  }

  async getNameLeadByName(name) {
    return await this.maybeThrottle(async () => {
      const rows =
          (await (this.target).select().from("NameLeads")
              .where({name}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
      return rows && rows[0] || null;
    });
  }

  async getNameLead(id) {
    return await this.maybeThrottle(async () => {
      const rows =
          (await (this.target).select().from("NameLeads")
              .where({id}))
            .map(row => {
              if (row.steps) {
                row.steps = JSON.parse(row.steps);
              }
              return row;
            });
      return rows && rows[0] || null;
    });
  }

  async addNameLead(id, name, status, steps) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("NameLeads")
          .insert({
            id,
            name,
            status,
            steps: JSON.stringify(steps)
          });
    });
  }

  async updateNameLead(id, status, steps) {
    return await this.maybeThrottle(async () => {
      const updated =
          await (this.target)("NameLeads")
              .where({id})
              .update({
                status,
                steps: JSON.stringify(steps),
              });
      // console.log(updated + " rows updated by updateNameLead(" + id + ", " + status + ", ...)");
      if (!updated) {
        throw "No rows updated by updateNameLead(" + id + ", " + status + ", ...)";
      }
    });
  }

  async getUnfinishedPageLeads(retryErrors) {
    return await this.maybeThrottle(async () => {
      let query = (this.target).select("PageLeads.*").from("PageLeads");
      if (retryErrors) {
        query = query.where(function() {
          this.where({"PageLeads.status": 'created'})
              .orWhere({"PageLeads.status": 'errors'});
        });
      } else {
        query = query.where({"PageLeads.status": 'created'})
      }
      query =
          query
            .leftJoin('Submissions', 'PageLeads.id', 'Submissions.submission_id')
            .whereNull('Submissions.submission_id')

      return (await query)
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
    });
  }

  async getUnfinishedNameLeads() {
    return await this.maybeThrottle(async () => {
      return (
          await (this.target).select("NameLeads.*").from("NameLeads")
              .where({"NameLeads.status": 'created'}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
    });
  }

  async getPageAnalysesByUrl(url) {
    return await this.maybeThrottle(async () => {
      return (
            await (this.target).select().from("PageAnalyses")
                .where({url}))
          .map(row => {
              if (row.steps) {
                row.steps = JSON.parse(row.steps);
                row.analysis = JSON.parse(row.analysis);
              }
              return row;
            });
    });
  }

  async getPageAnalysis(url) {
    return await this.maybeThrottle(async () => {
      const row =
          (await (this.target).select().from("PageAnalyses")
              .where({url}))
              .map(row => {
                if (row.steps) {
                  row.steps = JSON.parse(row.steps);
                  row.analysis = JSON.parse(row.analysis);
                }
                return row;
              });
      return row && row[0] || null;
    });
  }

  async startPageAnalysis(url) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("PageAnalyses")
          .insert({
            url,
            status: 'created'
          });
    });
  }

  async finishPageAnalysis(url, status, steps, analysis) {
    return await this.maybeThrottle(async () => {
      await (this.target)("PageAnalyses")
          .where({
            url: url
          })
          .update({
            status: status,
            steps: JSON.stringify(steps),
            analysis: JSON.stringify(analysis)
          });
    });
  }

  async getMatchAnalysis(submissionId, url) {
    return await this.maybeThrottle(async () => {
      const row =
          (await (this.target).select().from("MatchAnalyses")
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

  async getMatchAnalysesForSubmission(submissionId) {
    return await this.maybeThrottle(async () => {
      return (
            await (this.target).select().from("MatchAnalyses")
                .where({submission_id: submissionId}))
          .map(row => {
            if (row.steps) {
              row.steps = JSON.parse(row.steps);
            }
            return row;
          });
    });
  }

  async startMatchAnalysis(submissionId, url) {
    return await this.maybeThrottle(async () => {
      await (this.target).into("MatchAnalyses")
          .insert({
            submission_id: submissionId,
            url,
            steps: JSON.stringify([]),
            status: 'created',
            matchness: null
          });
    });
  }

  async finishMatchAnalysis(submissionId, url, status, steps, matchness) {
    return await this.maybeThrottle(async () => {
      await (this.target)("MatchAnalyses")
          .where({ submission_id: submissionId, url })
          .update({
            status: status,
            steps: JSON.stringify(steps),
            matchness: matchness
          });
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

  async getAnalysisQuestion(url, question, model, summarizePromptVersion) {
    return await this.maybeThrottle(async () => {
      const query = 
          (this.target).select()
          .from("AnalyzeCache")
          .where({
            url,
            question,
            model,
            summarize_prompt_version: summarizePromptVersion
          });
      // console.log("q:", query.toString());
      const rows = (await query)
          .map(row => {
            row.error = JSON.parse(row.error);
            return row;
          });
      return rows && rows[0];
    });
  }

  async createAnalysisQuestion(url, question, model, summarizePromptVersion) {
    return await this.maybeThrottle(async () => {
      const query =
         (this.target).into("AnalyzeCache")
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
      // console.log("q:", query.toString());
      return await query;
    });
  }

  async finishAnalysisQuestion(url, question, model, summarizePromptVersion, status, answerRaw, answer, errorText) {
    return await this.maybeThrottle(async () => {
      const query =
          (this.target)("AnalyzeCache")
          .where({
            url,
            question,
            model,
            summarize_prompt_version: summarizePromptVersion
          })
          .update({
            answer: answer == null ? null : answer.toString(),
            answer_raw: answerRaw,
            status,
            error: errorText == null ? null : (typeof errorText == 'object' ? JSON.stringify(errorText) : errorText.toString())
          });
      // console.log("q:", query.toString());
      return await query;
    });
  }

  async getConfirmedSubmissions() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions").where({status: "confirmed"});
    });
  }

  async getFailedSubmissions() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions").where({status: "failed"});
    });
  }

  async getFailedNeedLeads() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("PageLeads")
          .whereNot('future_submission_need', 0)
          .whereNot('status', "confirmed")
          .whereNot('status', "approved")
          .whereNot('status', "created")
          .whereNot('status', "success")
          .whereNot('status', 'buried');
    });
  }

  async getFailedNeedSubmissions() {
    return await this.maybeThrottle(async () => {
      return await (this.target).select().from("Submissions")
          .whereNot('need', 0)
          .whereNot('status', "created")
          .whereNot('status', "confirmed")
          .whereNot('status', "approved")
          .whereNot('status', "published")
          .whereNot('status', 'buried');
    });
  }

  async numApprovedSubmissions() {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target)("Submissions")
              .count('submission_id as count')
              .where('status', 'approved');
      // console.log("result:", result);
      return result && result[0] && result[0].count;
    });
  }

  async numCreatedInvestigations() {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target)("Investigations")
              .count('submission_id as count')
              .where('status', 'created');
      // console.log("result:", result);
      return result && result[0] && result[0].count;
    });
  }

  async numCreatedPageLeads() {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target)("PageLeads")
              .count('id as count')
              .where('status', 'created');
      // console.log("result:", result);
      return result && result[0] && result[0].count;
    });
  }

  async numCreatedNameLeads() {
    return await this.maybeThrottle(async () => {
      const result =
          await (this.target)("NameLeads")
              .count('id as count')
              .where('status', 'created');
      // console.log("result:", result);
      return result && result[0] && result[0].count;
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

  async findApprovedSubmissionsAt(at, limit) {
    return await this.maybeThrottle(async () => {
    	return await (this.target).select().from("Submissions")
    			.where({status: 'approved', state: at})
    			.limit(limit);
    });
  }

  async publishSubmission(submissionId, bestName, bestUrl) {
    return await this.maybeThrottle(async () => {
      // This *could* fail if there's already a submission with that name...
  	  await (this.target)("Submissions").where({'submission_id': submissionId}).update({
  			'status': 'published',
        'name': bestName,
        'url': bestUrl
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

  async getScrutiny(submissionId) {
    return await this.maybeThrottle(async () => {
      return (await (this.target)
        .select('a1.question', 'a1.model', 'a1.answer', 'a1.url')
        .from('AnalyzeCache as a1')
        .join('AnalyzeCache as a2', function() {
          this.on('a1.url', '=', 'a2.url')
            .andOn('a1.question', '=', 'a2.question')
            .andOn('a1.model', '<', 'a2.model')
            .andOnRaw("replace(lower(a1.answer), '.', '') != replace(lower(a2.answer), '.', '')");
        })
        .whereIn('a1.url', function() {
          this.select('m.url')
            .from('MatchAnalyses as m')
            .where('m.submission_id', '=', submissionId);
        }));
    });
  }
}
