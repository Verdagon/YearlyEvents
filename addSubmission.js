
import { normalizeName, normalizeState } from "./utils.js";

// export async function getSimilarSubmission(db, name, city, state) {
// 	const normalizedName = normalizeName(name, city, state);
// 	return db.getSimilarSubmission(normalizedName);
// }

export async function addSubmission(db, givenSubmission, approved) {
	const {name, city, state, description, url} = givenSubmission;
  const normalizedName = normalizeName(name, city, state);

	return await db.transaction(async (trx) => {
    const existing = await trx.getExistingSubmission(normalizedName, city, state);
    if (existing) {
    	return null;
    }
		const submission_id = crypto.randomUUID();
		const row = {
			name,
			normalized_name: normalizedName,
			state: state && normalizeState(state),
			city,
			description,
			submission_id: submission_id,
			status: approved ? 'approved' : 'created',
			url
		};
		await trx.insertSubmission(row);
		return submission_id;
	});
}
