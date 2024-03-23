import knexBuilder from 'knex';

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

	async getSimilarEvent(normalizedName) {
		const results =
				await (this.target).select().from("ConfirmedEvents")
				// ConfirmedEvents name is always normalized
	    			.where({name: normalizedName});
	  return results[0] || null;
	}

	// async getSimilarSubmission(normalizedName) {
	// 	const results =
	// 			await (this.target).select().from("Submissions")
	//     			.where({normalized_name: normalizedName});
	//   return results[0] || null;
	// }

	// async getSimilarSubmissionById(id) {
	// 	const results =
	// 			await (this.target)
	// 					.from("Submissions as s1")
	// 					.select("s2.*")
	// 					.where("s1.submission_id", id)
	// 			    .join("Submissions as s2", function() {
	// 			        this.on("s1.normalized_name", "=", "s2.normalized_name")
	// 			            .andOn("s1.submission_id", "!=", "s2.submission_id");
	// 			    });
	//   return results[0] || null;
	// }

	async getSimilarPublishedEventById(id) {
		const results =
				await (this.target)
						.from("ConfirmedEvents as e1")
						.select("e2.*")
						.where("e1.submission_id", id)
						.where("e1.status", "confirmed")
				    .join("ConfirmedEvents as e2", function() {
				        this.on("e1.name", "=", "e2.name")
				            .andOn("e1.id", "!=", "e2.id");
				    });
	  return results[0] || null;
	}

	async getExistingSubmission(normalizedName, city, state) {
		const results =
				await (this.target).select().from("Submissions")
	    			.where({normalized_name: normalizedName, city, state});
	  return results[0] || null;
	}

	async insertSubmission(row) {
		await (this.target).into("Submissions").insert(row);
	}


	async approveSubmission(submissionId) {
		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'approved'
		});
	}

	async rejectSubmission(submissionId) {
		await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'rejected'
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

	async cachePageSummary(row) {
		await (this.target).into("SummarizeCache").insert(row);
	}

	async updateSubmissionStatus(submissionId, status, eventId, investigation) {
		await (this.target)("Submissions").where({'submission_id': submissionId})
				.update({
					status: status,
					event_id: eventId,
					investigation: JSON.stringify(investigation)
				});
	}

	async insertEvent(row) {
		await (this.target).into("ConfirmedEvents").insert(row);
	}

	async insertConfirmation(row) {
		await (this.target).into("EventConfirmations").insert(row);
	}

	async getCreatedSubmissions(trx) {
		return await (this.target).select().from("Submissions").where({status: "created"});
	}

	async getAnalyzedEents(trx) {
    return await (this.target).select().from("ConfirmedEvents").where({status: "analyzed"});
  }

  async getEventConfirmations(eventId) {
    return await (this.target).select().from("EventConfirmations").where({event_id: eventId});
  }

  async getSubmission(submissionId) {
    const rows =
    		(await (this.target).select().from("Submissions").where({submission_id: submissionId}))
    		.map(row => {
    			row.investigation = JSON.parse(row.investigation);
    			return row;
    		});
		return rows[0] || null;
  }

  async getSubmissionEvent(submissionId) {
    const rows =
        await (this.target).select().from("ConfirmedEvents").where({submission_id: submissionId});
    return rows && rows[0] || null;
  }

  async publishEvent(eventId) {
	  await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
			'status': 'published'
		});
	}

	async rejectEvent(eventId) {
    await (this.target)("ConfirmedEvents").where({'id': eventId}).update({
			'status': 'rejected'
		});
  }

  async rejectSubmission(submissionId) {
    await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'rejected'
		});
  }

  async approveSubmission(submissionId) {
    await (this.target)("Submissions").where({'submission_id': submissionId}).update({
			'status': 'approved'
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
