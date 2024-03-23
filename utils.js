
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
				"’",
				"'",
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
