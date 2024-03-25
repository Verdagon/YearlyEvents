
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
