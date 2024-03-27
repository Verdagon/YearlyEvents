import knexBuilder from 'knex';
import { parallelEachI } from "../Common/parallel.js";

export class LocalDb {
	constructor(parent, dbPath) {
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
		return await this.knex.transaction(async (trx) => {
			return await inner(new LocalDb(trx, null));
		});
	}

	async getFromDb(tableName, cacheCounter, where, jsonFields) {
	  let response =
	    await (this.target)
	      .select()
	      .from(tableName)
	      .where(where)
	      .limit(1);
	  if (response.length == 0 || response[0] == null) {
	    return null;
	  }
	  cacheCounter.count++;
	  const result = response[0];
	  for (const jsonField of (jsonFields || [])) {
	    result[jsonField] = JSON.parse(result[jsonField]);
	  }
	  return result;
	}

	async getSimilarNonRejectedEvent(normalizedName) {
		const results =
				await (this.target).select().from("ConfirmedEvents")
				// ConfirmedEvents name is always normalized
	    			.where({name: normalizedName})
	    			.whereNot({status: 'rejected'});
	  return results[0] || null;
	}

	async getSimilarSubmission(normalizedName) {
		const results =
				await (this.target).select().from("Submissions")
	    			.where({name: normalizedName});
	  return results[0] || null;
	}

	async getSimilarSubmissionById(id) {
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
	}

	async getSimilarPublishedEventById(id) {
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
	}

	async getExistingSubmission(normalizedName, city, state) {
		const results =
				await (this.target).select().from("Submissions")
	    			.where({name: normalizedName, city, state});
	  return results[0] || null;
	}

	async insertSubmission(row) {
		await (this.target).into("Submissions").insert(row);
	}


	async approveSubmission(submissionId, need) {
		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'approved',
      'need': need
		});
	}

	async rejectSubmission(submissionId) {
		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'rejected'
		});
	}

  async burySubmission(submissionId) {
    await (this.target)("Submissions").where({'submission_id': submissionId}).update({
      'status': 'buried'
    });
  }

	async getApprovedSubmissions(trx) {
		return await (this.target).select().from("Submissions")
	      .whereNotNull("name")
	      .whereNotNull("state")
	      .whereNotNull("city")
	      .where({status: 'approved'});
	}

	async cachePageText(row) {
		await (this.target).into("PageTextCache").insert(row);
	}

  async getPageText(url) {
    const result = await (this.target).from("PageTextCache").select().where({url});
    return (result && result[0]) || null;
  }

	async cachePageSummary(row) {
		await (this.target).into("SummarizeCache").insert(row);
	}

	async updateSubmissionStatus(submissionId, status) {
		await (this.target)("Submissions")
        .where({'submission_id': submissionId})
				.update({ status: status });
	}

  async addInvestigation(submissionId, model, status, investigation, steps, pageAnalyses) {
    await (this.target).into("Investigations")
        .insert({
          submission_id: submissionId,
          status: status,
          model: model,
          steps: JSON.stringify(steps),
          investigation: JSON.stringify(investigation)
        });
    await parallelEachI(pageAnalyses, async (_, pageAnalysis) => {
      const {submissionId, url, status, model, steps, analysis} = pageAnalysis;
      await (this.target).into("PageAnalyses")
          .insert({
            submission_id: submissionId,
            url: url,
            status: status,
            steps: JSON.stringify(steps),
            analysis: JSON.stringify(analysis)
          });
    });
  }

	async insertEvent(row) {
		await (this.target).into("ConfirmedEvents").insert(row);
	}

	async insertConfirmation(row) {
		await (this.target).into("EventConfirmations").insert(row);
	}

	async getCreatedSubmissions() {
		return await (this.target).select().from("Submissions").where({status: "created"});
	}

	async getAnalyzedEvents() {
    return await (this.target).select().from("ConfirmedEvents").where({status: "analyzed"});
  }

  async getFailedSubmissions() {
    return await (this.target).select().from("Submissions").where({status: "failed"});
  }

  async getFailedNeedSubmissions() {
    return await (this.target).select().from("Submissions").whereNot('need', 0).where({status: "failed"}).orWhere({status:'errors'});
  }

  async getEventConfirmations(eventId) {
    return await (this.target).select().from("EventConfirmations").where({event_id: eventId});
  }

  async getSubmission(submissionId) {
    const rows = (await (this.target).select().from("Submissions").where({submission_id: submissionId}));
		return rows[0] || null;
  }

  async getInvestigations(submissionId) {
    return (await (this.target).select().from("Investigations").where({submission_id: submissionId}));
  }

  async getPageAnalyses(submissionId, model) {
    return (await (this.target).select().from("PageAnalyses").where({submission_id: submissionId, model: model}))
    		.map((row) => {
    			row.steps = JSON.parse(row.steps);
    			row.analysis = JSON.parse(row.analysis);
    			return row;
    		});
  }

  async findApprovedSubmissionsAt(at, limit) {
  	return await (this.target).select().from("Submissions")
  			.where({status: 'approved', state: at})
  			.limit(limit);
  }

  async getSubmissionEvent(submissionId) {
    const rows =
        await (this.target).select().from("ConfirmedEvents").where({submission_id: submissionId});
    return rows && rows[0] || null;
  }

  async publishEvent(eventId, bestUrl) {
	  await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
			'status': 'published',
      'best_url': bestUrl
		});
	}

	async rejectEvent(eventId) {
    await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
			'status': 'rejected'
		});
  }

	async cacheGoogleResult({query, response}) {
		await (this.target).into("GoogleCache")
				.insert({query, response: JSON.stringify(response)});
	}
}

// export async function dbCachedZ(knex, tableName, cacheCounter, cacheKeyMap, inner, transform, cacheIf, jsonFields) {
//   try {
//     const untransformedResult =
//         await getFromDb(
//             knex, tableName, cacheCounter, cacheKeyMap, jsonFields);
//     if (untransformedResult == null) {
//       throw null;
//     }
//     try {
//       const transformedResult = await transform(untransformedResult);
//       console.log("Reusing result from cache.");
//       cacheCounter.count++;
//       return transformedResult;
//     } catch (reason) {
//       console.log("Not using result from cache: ", reason);
//       throw null;
//     }
//   } catch (readFileError) {
//     const result = await inner();
//     if (typeof result != 'object') {
//       throw "dbCached inner result must be an object!";
//     }
//     if (cacheIf(result)) {
//       knex.into(tableName).insert(result);
//     }
//     return result;
//   }
// }
