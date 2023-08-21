// Invoked like: node index.js verdagon

// Uses this google programmable search engine thing:
//   https://programmablesearchengine.google.com/controlpanel/overview?cx=8710d4180bdfd4ba9
// and uses REST to invoke the api, like described in:
//   https://developers.google.com/custom-search/v1/using_rest

var urlencode = require('urlencode');

(async () => {
	const query = process.argv[2];

	const url =
		"https://www.googleapis.com/customsearch/v1?key=AIzaSyCwpUbnvlMRWes3Wz-24L12lCvSkYUNAdY&cx=8710d4180bdfd4ba9&q=" + urlencode(query);

	const body = await (
		fetch(url)
	    .catch(error => {
	        if (typeof error.json === "function") {
	            error.json().then(jsonError => {
	                console.log("Json error from API");
	                console.log(jsonError);
	                process.exit(1)
	            }).catch(genericError => {
	                console.log("Generic error from API");
	                console.log(error.statusText);
	                process.exit(1)
	            });
	        } else {
	            console.log("Fetch error");
	            console.log(error);
	            process.exit(1)
	        }
	    })
	    .then(response => {
	        if (!response.ok) {
	            return Promise.reject(response);
	        }
	        return response.json();
	    }));

	if (!body.items) {
		console.log("Bad response error: ", body);
		process.exit(1);
	}
	if (!body.items.length) {
		console.log("Bad response error: ", body);
		process.exit(1);
	}

	for (let i = 0; i < body.items.length && i < 6; i++) {
		const item = body.items[i];

		console.log(item.link);
	}
})();
