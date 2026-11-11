/** Apply direct behavior filters before the declaration is prepared/merged. */
export function callDefinitionFilters(definition) {
	const ownFilter = definition.definitionFilter
	const filters = []
	for (const behavior of Array.isArray(definition.behaviors) ? definition.behaviors : []) {
		const filter = behavior?.definitionFilter
		if (typeof filter === 'function') {
			filters.push(filter)
			// eslint-disable-next-line no-useless-call -- WeChat 2.25.3 exparser calls direct definition filters with a null receiver.
			filter.call(null, definition)
		}
	}
	return typeof ownFilter === 'function'
		? fields => ownFilter(fields, filters)
		: null
}

/** Behavior registration preserves its own filter for consumers of that behavior. */
export function registerBehavior(definition) {
	const behavior = { ...definition }
	behavior.definitionFilter = callDefinitionFilters(behavior)
	return behavior
}
