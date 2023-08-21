import util from 'node:util';
import { execFile } from 'node:child_process'
import { compareEvents, interrogatePage } from './compareEvents.js'
import fs from "fs/promises";
import { addEvent } from '../Server/add.js'
import knexBuilder from 'knex';

const knex = knexBuilder({
  client: 'sqlite3', // or 'better-sqlite3'
  connection: {
    filename: "./db.sqlite"
  },
  useNullAsDefault: true
});


const operation = process.argv[2];
if (operation == "") {
	console.log("Please enter an operation destination for the first argument.")
	console.log("Example usage:")
	console.log("    node list.js list result.csv")
	process.exit(1)
}


const files = await fs.readdir("./events");

const results = [];

let num_events = 0;
let num_rejects = 0;


for (const id of files) {
	if (!id.indexOf("-") < 0) {
		console.log("Skipping filename:", id)
		continue;
	}

	const json = await fs.readFile("./events/" + id, { encoding: 'utf8' });
	const entry = JSON.parse(json);

	if (!entry.name) {
		console.log("Malformed, missing name:", json);
		continue;
	}
	if (!entry.coords) {
		console.log("Adding missing coordinates for", entry.name);
		const response = await fetch("https://maps.googleapis.com/maps/api/geocode/json?key=AIzaSyCVKULMvP8TPRwh3B6VmwIq_8dWR9_GkSI&address=" + encodeURIComponent(entry.city + "," + entry.state));
		const responseJSON = await response.json();
		if (responseJSON.status != "OK") {
			throw "Bad geocode response!";
		}
		entry.coords = responseJSON.results[0].geometry.location;
		console.log("Writing coordinates:", entry.coords);
		await fs.writeFile("./events/" + id, JSON.stringify(entry));
	}
	if (!entry.id) {
		console.log("Fixing missing ID");
		entry.id = crypto.randomUUID();
		await fs.writeFile("./events/" + id, JSON.stringify(entry));
	}
	if (!entry.dbId) {
		console.log("Adding to DB");
		const toInsert = Object.assign({}, entry, {latitude: entry.coords.lat, longitude: entry.coords.lng});
		entry.dbId = await addEvent(knex, toInsert, toInsert.confirms);
		await fs.writeFile("./events/" + id, JSON.stringify(entry));
	}
	await fs.writeFile("./events/" + entry.id, JSON.stringify(entry));
	if (entry.confirms && entry.confirms.length > 0) {
		results.push(entry);
		num_events++;
	} else {
		num_rejects++;
	}
}

// let smallifiedResults = [];
// for (let event of results) {
// 	let {city, state, name, id, confir}
// }

if (operation == "list") {
	const destFilePath = process.argv[3];
	if (destFilePath == "") {
		console.log("Please enter a destination for the first argument.")
		console.log("Example usage:")
		console.log("    node list.js list result.csv")
		process.exit(1)
	}

	// Note its writing not appending
	await fs.writeFile(destFilePath, JSON.stringify(results));

	console.log("Done! " + num_events + " locations written, " + num_rejects + " rejected.");
} else if (operation == "setMonth") {
	const id = process.argv[3];
	if (id == "") {
		console.log("Missing ID. Example usage:")
		console.log("    node list.js setMonth dd6a21f9-3e0c-495b-969b-1cfb43edc6ed January")
		process.exit(1)
	}
	const month = process.argv[4];
	if (month == "") {
		console.log("Missing month. Example usage:")
		console.log("    node list.js setMonth dd6a21f9-3e0c-495b-969b-1cfb43edc6ed January")
		process.exit(1)
	}

	const json = await fs.readFile("./events/" + id, { encoding: 'utf8' });
	const entry = JSON.parse(json);
	entry.month = month;
	console.log("Updated month to " + month);
	console.log("New entry:");
	console.log(entry);
	await fs.writeFile("./events/" + entry.id, JSON.stringify(entry));
	console.log("Wrote event.")

	// console.log("Done! " + num_events + " locations written, " + num_rejects + " rejected.");
} else {
	console.log("Unknown operation");
}



// // Note its writing not appending
// await fs.writeFile(destFilePath, "Name,Location,Month,Url1,Url2\n");

// let num_events = 0;
// let num_rejects = 0;

// for (const filename of files) {
// 	if (!filename.endsWith(".json")) {
// 		continue;
// 	}

// 	let [state, city, name] = filename.substring(0, filename.length - ".json".length).split(";");

// 	const json = await fs.readFile("./events/" + filename, { encoding: 'utf8' });
// 	const obj = JSON.parse(json);
// 	const {confirms, rejects, month, num_errors, num_promising} = obj;
// 	if (confirms && confirms.length > 0) {
// 		await fs.appendFile(destFilePath, "\"" + name + "\",\"" + city + "," + state + "\",\"" + month + "\",\"" + confirms[0].url + "\",\"" + (confirms.length > 1 ? confirms[1].url : "") + "\"\n");
// 		num_events++;
// 	} else {
// 		num_rejects++;
// 	}
// }

// console.log("Done! " + num_events + " locations written, " + num_rejects + " rejected.");
