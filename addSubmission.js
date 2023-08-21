
export async function addSubmission(knex, givenSubmission) {
	return await knex.transaction(async (trx) => {
		const {name, city, state, description} = givenSubmission;

		const submission_id = crypto.randomUUID();

		const submission = {name, state, city, description, submission_id: submission_id};

		console.log("Inserting:", submission);
		await trx.insert(submission).into("Submissions");	

		return submission_id;
	});
}
