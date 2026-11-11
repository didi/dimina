export function configurePureDataPattern(definition, extraInfo = {}) {
	if (Object.prototype.hasOwnProperty.call(extraInfo, 'pureDataPattern')) {
		definition.options = { ...definition.options, pureDataPattern: new RegExp(extraInfo.pureDataPattern) }
	}
}

export function isPureDataField(pattern, key) {
	return pattern instanceof RegExp && pattern.test(key)
}

export function filterRenderData(data, pattern) {
	if (!(pattern instanceof RegExp)) return data
	return Object.fromEntries(Object.entries(data || {}).filter(([key]) => !isPureDataField(pattern, key)))
}
