
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function makeMsThrottler(msBetweenRequests) {
	let lastThrottleMillis = Date.now()
	return async () => {
        if (msBetweenRequests) {
    		const now = Date.now()
    		const millisSinceLastThrottle = now - lastThrottleMillis;
    		// Lets only make a request every second or so, since we only get 60 RPS to chatgpt.
    		if (millisSinceLastThrottle < msBetweenRequests) {
    			await delay(msBetweenRequests - millisSinceLastThrottle);
    		}
    		lastThrottleMillis = now;
        }
	}
}

export async function parallelEachI(arr, asyncInner) {
	if (!Array.isArray(arr)) {
	  throw "Param arr isnt array.";
	}
	return await Promise.all(Array.from(arr.entries()).map(async ([i, x]) => await asyncInner(i, x)));
}


async function tryThenElse(body, then, ellse) {
    let result;
    try {
        result = await body();
    } catch (e) {
        return await ellse(e);
    }
    return await then(result);
}

async function tryThen(body, then) {
    return await tryThenElse(body, then, async (e) => e);
}

async function tryElse(body, ellse) {
    return await tryThenElse(body, async (x) => x, ellse);
}

export class Semaphore {
    /**
     * Creates a semaphore that limits the number of concurrent Promises being handled
     * @param {*} maxConcurrentRequests max number of concurrent promises being handled at any time
     */
    constructor(maxConcurrentRequests = null, msBetweenRequests = null) {
        this.currentRequests = [];
        this.runningRequests = 0;
        this.maxConcurrentRequests = maxConcurrentRequests;
        this.msBetweenRequests = msBetweenRequests || 0;
        this.prioritizing = false;
        this.throttler = makeMsThrottler(msBetweenRequests);
    }

    /**
     * Returns a Promise that will eventually return the result of the function passed in
     * Use this to limit the number of concurrent function executions
     * @param {*} fnToCall function that has a cap on the number of concurrent executions
     * @returns Promise that will resolve with the resolved value as if the function passed in was directly called
     */
    do(fnToCall) {
        return new Promise((resolve, reject) => {
            this.currentRequests.push({ resolve, reject, fnToCall, priority: 0 });
            this.tryNext();
        });
    }

    /**
     * Returns a Promise that will eventually return the result of the function passed in
     * Use this to limit the number of concurrent function executions
     * @param {*} priority Priority for this function. Higher means it's run sooner.
     * @param {*} fnToCall function that has a cap on the number of concurrent executions
     * @returns Promise that will resolve with the resolved value as if the function passed in was directly called
     */
    prioritized(priority, fnToCall) {
        this.prioritizing = true;
        return new Promise((resolve, reject) => {
            this.currentRequests.push({ resolve, reject, fnToCall, priority: priority || 0 });
            this.tryNext();
        });
    }

    tryNext() {
        if (!this.currentRequests.length) {
            return;
        } else if (this.runningRequests < this.maxConcurrentRequests || this.maxConcurrentRequests == null) {
            let highestPriorityFound = this.currentRequests[0].priority;
            let highestPriorityIndex = 0;
            if (this.prioritizing) {
                for (let i = 1; i < this.currentRequests.length; i++) {
                    if (this.currentRequests[i].priority > highestPriorityFound) {
                        highestPriorityFound = this.currentRequests[i].priority;
                        highestPriorityIndex = i;
                    }
                }
            }
            let { resolve, reject, fnToCall } = this.currentRequests[highestPriorityIndex];
            this.currentRequests.splice(highestPriorityIndex, 1);

            this.runningRequests++;

            (this.throttler)()
                .then(fnToCall)
                .then((res) => resolve(res))
                .catch((err) => reject(err))
                .finally(() => {
                    this.runningRequests--;
                    this.tryNext();
                });
        }
    }
}

