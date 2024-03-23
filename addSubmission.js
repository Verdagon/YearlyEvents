
import { normalizeName } from "./utils.js";

export async function getSimilarSubmission(knex, name, city, state) {
	const normalizedName = normalizeName(name, city, state);
	const results =
			await knex.select().from("Submissions")
    			.where({normalized_name: normalizedName});
  return results[0] || null;
}

export async function addSubmission(knex, givenSubmission, approved) {
	const {name, city, state, description, url} = givenSubmission;
  const normalizedName = normalizeName(name, city, state);

	return await knex.transaction(async (trx) => {
    const existing =
    	await trx.select().from("Submissions")
    		.where({normalized_name: normalizedName, city, state});
    if (existing.length) {
    	return null;
    } else {
			const submission_id = crypto.randomUUID();
			const row = {
				name,
				normalized_name: normalizedName,
				state,
				city,
				description,
				submission_id: submission_id,
				status: approved ? 'approved' : 'created',
				url
			};
			await trx.into("Submissions").insert(row);
			return submission_id;
		}
	});
}
