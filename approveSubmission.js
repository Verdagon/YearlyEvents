
export async function approveSubmission(knex, submissionId) {
	await knex("Submissions").where({'submission_id': submissionId}).update({
		'status': 'approved'
	});
}

export async function rejectSubmission(knex, submissionId) {
	await knex("Submissions").where({'submission_id': submissionId}).update({
		'status': 'rejected'
	});
}
