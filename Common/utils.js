
import terminate from 'terminate';
import { execFile, spawn } from 'node:child_process'

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

const STATE_SYNONYMS = [
    ['alabama', 'al'],
    ['alaska', 'ak'],
    ['arizona', 'az'],
    ['arkansas', 'ar'],
    ['california', 'ca'],
    ['colorado', 'co'],
    ['connecticut', 'ct'],
    ['delaware', 'de'],
    ['florida', 'fl'],
    ['georgia', 'ga'],
    ['hawaii', 'hi'],
    ['idaho', 'id'],
    ['illinois', 'il'],
    ['indiana', 'in'],
    ['iowa', 'ia'],
    ['kansas', 'ks'],
    ['kentucky', 'ky'],
    ['louisiana', 'la'],
    ['maine', 'me'],
    ['maryland', 'md'],
    ['massachusetts', 'ma'],
    ['michigan', 'mi'],
    ['minnesota', 'mn'],
    ['mississippi', 'ms'],
    ['missouri', 'mo'],
    ['montana', 'mt'],
    ['nebraska', 'ne'],
    ['nevada', 'nv'],
    ['new hampshire', 'nh', 'n.h.', 'n. h.'],
    ['new jersey', 'nj', 'n.j.', 'n. j.'],
    ['new mexico', 'nm', 'n.m.', 'n. m.'],
    ['new york', 'ny', 'n.y.', 'n. y.'],
    ['north carolina', 'nc', 'n.c.', 'n. c.'],
    ['north dakota', 'nd', 'n.d.', 'n. d.'],
    ['ohio', 'oh'],
    ['oklahoma', 'ok'],
    ['oregon', 'or'],
    ['pennsylvania', 'pa'],
    ['rhode island', 'ri', 'r.i.', 'r. i.'],
    ['south carolina', 'sc', 's.c.', 's. c.'],
    ['south dakota', 'sd', 's.d.', 's. d.'],
    ['tennessee', 'tn'],
    ['texas', 'tx'],
    ['utah', 'ut'],
    ['vermont', 'vt'],
    ['virginia', 'va'],
    ['washington', 'wa'],
    ['west virginia', 'wv', 'w.v.', 'w. v.'],
    ['wisconsin', 'wi'],
    ['wyoming', 'wy'],
];

export function normalizeState(stateName) {
	const lowered = stateName.toLowerCase();
	for (const row of STATE_SYNONYMS) {
  	if (row.includes(lowered)) {
  		return row[0].split(" ").map(x => x.toUpperCase()).join(" ");
  	}
  }
  return stateName;
}

export function getLowercasedSynonyms(stateName) {
	const lowered = stateName.toLowerCase();
	for (const row of STATE_SYNONYMS) {
  	if (row.includes(lowered)) {
  		return row;
  	}
  }
  return [stateName];
}

export function normalizeName(name, city, state) {
	const prefixesToRemove =
			[
				" ",
				".",
				"-",
				"’s",
				"'s",
				"’",
				"'",
				"*",
				"international",
				"national",
				"annual",
				"yearly",
				"world",
				"state",
				"us",
				"the"
			];
	if (city) {
		prefixesToRemove.push(city);
	}
	if (state) {
		prefixesToRemove.push(...getLowercasedSynonyms(state));
	}
	return unprependiall(name, prefixesToRemove, 9);
}

class VException {
	constructor(...args) {
		this.message = args;
	}
}

function stringify(...args) {
	return args.map(arg => typeof arg == 'object' ? JSON.stringify(arg) : arg + "").join(" ");
}

export function logs(...destinations) {
	const funcs = [];
	let useStdout = true;
	for (const destination of destinations) {
		if (Array.isArray(destination)) {
			funcs.push((...args) => {
				if (args.length == 1) {
					destination.push(args[0]);
				} else {
					destination.push(args);
				}
			});
		} else if (typeof destination == 'boolean') {
			useStdout = destination;
		} else {
			throw "Weird log() destination: " + JSON.stringify(destination);
		}
	}
	funcs.unshift((...args) => {
		if (args.length == 1 && typeof args[0] == 'object' && args[0][""] !== undefined) {
			// Because we want to e.g.
			//   logs(steps)({ "": "Asking GPT to describe page text at " + url, "pageTextUrl": url });
			// to include some extra metadata to the steps logs.
			useStdout ? console.log(args[0][""]) : console.error(args[0][""]);
		} else {
			useStdout ? console.log(...args) : console.error(...args);
		}
	});
	return function(...args) {
		for (const func of funcs) {
			func(...args);
		}
		return new VException(args);
	}
}

export function onlyUnique(value, index, array) {
  return array.indexOf(value) === index;
}
export function distinct(a) {
  return a.filter(onlyUnique);
}


export function makeLineServerProcess(executable, flags, readyLine) {
  const child = spawn(executable, flags);
  child.stdin.setEncoding('utf-8');
  child.stdout.setEncoding('utf-8');
  child.stderr.pipe(process.stdout);

  let instance = null;

  return new Promise((readyResolve, readyReject) => {
    let bufferFromChildStdout = "";
    child.stdout.on('data', data => {
      bufferFromChildStdout += data;
      while (true) {
        const newlineIndex = bufferFromChildStdout.indexOf('\n');
        if (newlineIndex >= 0) {
          const line = bufferFromChildStdout.slice(0, newlineIndex);
          bufferFromChildStdout = bufferFromChildStdout.slice(newlineIndex + 1);
          if (instance == null) {
            if (line == readyLine) {
              instance = new LineServerProcess(child);
              readyResolve(instance);
            } else {
              console.error("Received unexpected line from child process, ignoring:", line);
            }
          } else {
            instance.onLine(line);
          }
        } else {
          break;
        }
      }
    });

    child.on('error', error => {
      if (instance) {
        instance.onError();
        console.error("Received error from fetcher:", error);
      } else {
        readyReject(error);
      }
    });

    child.on('close', code => {
      if (instance) {
        instance.onClose(code);
      } else {
        // We might have already rejected from the error handler, but that's fine.
        readyReject(code);
      }
    });
  });
}

export function splitOnce(str, delim) {
  const delimIndex = str.indexOf(' ');
  if (delimIndex < 0) {
    return null;
  }
  const requestId = str.slice(0, delimIndex);
  const rest = str.slice(delimIndex + 1);
  return [requestId, rest];
}

export function newPromise() {
  let resolver;
  let rejecter;
  const promise = new Promise((res, rej) => {
    resolver = res;
    rejecter = rej;
  });
  return [promise, resolver, rejecter];
}

class LineServerProcess {
  constructor(child, readyLine, onLine) {
    this.child = child;
    this.requestHandlers = {};
  }
  async destroy() {
    this.child.stdin.end();
    return new Promise((resolver, rejecter) => {
      terminate(this.child.pid, err => {
        if (err) {
          rejecter(err);
        } else {
          resolver();
        }
      });
    });
  }
  // These are meant to be overridden
  onLine(line) {
    const maybeRequestIdAndRest = splitOnce(line, ' ');
    if (!maybeRequestIdAndRest) {
      console.error("Weird line from fetcher:", line);
      return;
    }
    const [requestId, afterRequestId] = maybeRequestIdAndRest;
    const handlerPair = this.requestHandlers[requestId];
    if (!handlerPair) {
      console.error("Line from fetcher without handler:", line);
      return;
    }
    delete this.requestHandlers[requestId];
    const [resolver, rejecter] = handlerPair;
    try {
      const maybeStatusAndRest = splitOnce(afterRequestId, ' ');
      if (!maybeStatusAndRest) {
        console.error("Weird line from fetcher: " + responseLine);
        return;
      }
      const [status, rest] = maybeStatusAndRest;
      if (status == 'success') {
        resolver(rest);
      } else {
        rejecter({status, rest});
      }
    } catch (e) {
      rejecter({status: "", rest: e});
    }
  }
  onError(err) {
    console.error("Error from LineServerProcess:", err);
  }
  onClose(code) {
    // console.error("LineServerProcess closed:", code);
  }
  send(request) {
    const requestId = crypto.randomUUID();

    let line = requestId + " " + request;
    line = line.endsWith('\n') ? line : line + "\n";
    this.child.stdin.write(line);

    const [promise, resolver, rejecter] = newPromise();
    this.requestHandlers[requestId] = [resolver, rejecter];
    return promise;
  }
}
