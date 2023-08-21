
export function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function makeThrottler(msBetweenRequests) {
	let lastThrottleMillis = Date.now()
	return async () => {
		const now = Date.now()
		const millisSinceLastThrottle = now - lastThrottleMillis;
		// Lets only make a request every second or so, since we only get 60 RPS to chatgpt.
		if (millisSinceLastThrottle < msBetweenRequests) {
			await delay(msBetweenRequests - millisSinceLastThrottle);
		}
		lastThrottleMillis = now;
	}
}

export class Semaphore {
    /**
     * Creates a semaphore that limits the number of concurrent Promises being handled
     * @param {*} maxConcurrentRequests max number of concurrent promises being handled at any time
     */
    constructor(maxConcurrentRequests = 1) {
        this.currentRequests = [];
        this.runningRequests = 0;
        this.maxConcurrentRequests = maxConcurrentRequests;
    }

    /**
     * Returns a Promise that will eventually return the result of the function passed in
     * Use this to limit the number of concurrent function executions
     * @param {*} fnToCall function that has a cap on the number of concurrent executions
     * @returns Promise that will resolve with the resolved value as if the function passed in was directly called
     */
    do(fnToCall) {
        return new Promise((resolve, reject) => {
            this.currentRequests.push({ resolve, reject, fnToCall });
            this.tryNext();
        });
    }

    tryNext() {
        if (!this.currentRequests.length) {
            return;
        } else if (this.runningRequests < this.maxConcurrentRequests) {
            let { resolve, reject, fnToCall } = this.currentRequests.shift();
            this.runningRequests++;
            let req = fnToCall();
            req.then((res) => resolve(res))
                .catch((err) => reject(err))
                .finally(() => {
                    this.runningRequests--;
                    this.tryNext();
                });
        }
    }
}

export function unprependi(str, prefix, minLength) {
	if (str.toLowerCase().startsWith(prefix.toLowerCase())) {
		const result = str.substring(prefix.length);
		if (minLength != null) {
			if (result.length >= minLength) {
				return result;
			}
		} else {
			return result;
		}
	}
	return str;
}

export function unprependiall(originalStr, prefixes, minLength) {
	for (let prefix of prefixes) {
		const newStr = unprependi(originalStr, prefix, minLength);
		if (newStr.length != originalStr.length) {
			return unprependiall(newStr, prefixes, minLength);
		}
	}
	return originalStr;
}

export function normalizeName(name, city, state) {
	return unprependiall(
			name,
			[
				" ",
				".",
				"-",
				"international ",
				"national ",
				"annual ",
				"yearly ",
				"world ",
				"state ",
				"us ",
				"the ",
				city + " ",
				state + " ",
				city + "'s",
				state + "'s"
			],
			9);
}
