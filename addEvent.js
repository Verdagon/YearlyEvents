
export async function addEvent(knex, originalEvent, originalSources) {
	return await knex.transaction(async (trx) => {
		const {id: event_id, name, state, city, month, latitude, longitude} = originalEvent;
		if (event_id == null) throw "Missing id!";
		if (name == null) throw "Missing name!";
		if (state == null) throw "Missing state!";
		if (city == null) throw "Missing city!";
		if (month == null) throw "Missing month!";
		if (latitude == null) throw "Missing latitude!";
		if (longitude == null) throw "Missing longitude!";
		const event = {event_id, name, state, city, month, latitude, longitude, summary: ""};

		console.log("Inserting:", event);
		await trx.insert(event).into("Events");	

		const sources = [];
		for (let originalSource of originalSources) {
			const {url, pageText, analysis} = originalSource;
			const source_id = crypto.randomUUID();
			if (url == null) throw "Missing url!";
			if (pageText == null) throw "Missing pageText!";
			if (analysis == null) throw "Missing analysis!";
			const source_event_id = event_id;
			sources.push({source_id, source_event_id, url, pageText, analysis});
		}
		if (sources.length) {
			await trx.insert(sources).into("Sources");
			console.log("Inserted sources:", sources.map(x => x.source_id));
		} else {
			console.log("Inserted no sources.");
		}

		return event_id;
	});
}
