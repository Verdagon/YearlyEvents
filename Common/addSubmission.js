
import { normalizeName, normalizeState, normalizePlace } from "./utils.js";

// export async function getSimilarSubmission(db, name, city, state) {
// 	const normalizedName = normalizeName(name, city, state);
// 	return db.getSimilarSubmission(normalizedName);
// }

export async function addSubmission(db, givenSubmission) {
	const {status, name, city, state, description, url, origin_query, need} = givenSubmission;
  const normalizedName = normalizeName(name, city, state);
  const submission_id = givenSubmission.submission_id || crypto.randomUUID();

	return await db.transaction(async (trx) => {
    const existing = await trx.getExistingSubmission(normalizedName, city, state);
    if (existing) {
    	return existing.submission_id;
    }
    // console.log("Adding submission");
		const row = {
			name: normalizedName,
			state: state && normalizeState(state),
			city: normalizePlace(city),
			description,
			submission_id,
			status,
			url,
			origin_query,
      need,
      scrutinize: 0
		};
		await trx.insertSubmission(row);
    // console.log("Added submission");
		return submission_id;
	});
}
