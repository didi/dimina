const DATA_FUNCTION_REFERENCE_KEY = '__dimina_data_function_reference__'
const DATA_FUNCTION_REFERENCE_VERSION = 1

export function createDataFunctionReference(id) {
	return {
		[DATA_FUNCTION_REFERENCE_KEY]: id,
		version: DATA_FUNCTION_REFERENCE_VERSION,
	}
}

export function isDataFunctionReference(value) {
	return value !== null
		&& typeof value === 'object'
		&& value.version === DATA_FUNCTION_REFERENCE_VERSION
		&& typeof value[DATA_FUNCTION_REFERENCE_KEY] === 'string'
		&& Object.keys(value).length === 2
}

export function getDataFunctionReferenceId(value) {
	return isDataFunctionReference(value)
		? value[DATA_FUNCTION_REFERENCE_KEY]
		: undefined
}

/**
 * Recursively transform functions and their bridge references without applying
 * JSON semantics to the surrounding data. This keeps Dates, typed arrays and
 * other bridge-supported values intact while making functions transferable.
 */
export function transformDataFunctions(value, { mapFunction, mapReference } = {}, seen = new WeakMap()) {
	if (typeof value === 'function') {
		return mapFunction ? mapFunction(value) : value
	}
	if (value === null || typeof value !== 'object') {
		return value
	}
	if (isDataFunctionReference(value)) {
		return mapReference ? mapReference(value) : value
	}
	if (
		value instanceof Date
		|| value instanceof RegExp
		|| value instanceof ArrayBuffer
		|| ArrayBuffer.isView(value)
	) {
		return value
	}
	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) {
			return value
		}
	}
	if (seen.has(value)) {
		return seen.get(value)
	}

	const transformed = Array.isArray(value) ? [] : {}
	seen.set(value, transformed)
	for (const key of Object.keys(value)) {
		transformed[key] = transformDataFunctions(value[key], { mapFunction, mapReference }, seen)
	}
	return transformed
}
