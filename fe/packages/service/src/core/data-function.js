import {
	createDataFunctionReference,
	getDataFunctionReferenceId,
	transformDataFunctions,
	uuid,
} from '@dimina/common'

let referenceByFunction = new WeakMap()
const functionByReference = new Map()

export function registerDataFunction(fn) {
	const existingReference = referenceByFunction.get(fn)
	if (existingReference) {
		functionByReference.set(existingReference, fn)
		return existingReference
	}

	let reference
	do {
		reference = `data-function-${uuid()}`
	} while (functionByReference.has(reference))
	referenceByFunction.set(fn, reference)
	functionByReference.set(reference, fn)
	return reference
}

export function resolveDataFunction(reference) {
	return functionByReference.get(reference)
}

export function encodeDataFunctions(value) {
	return transformDataFunctions(value, {
		mapFunction(fn) {
			return createDataFunctionReference(registerDataFunction(fn))
		},
	})
}

export function decodeDataFunctions(value) {
	return transformDataFunctions(value, {
		mapReference(reference) {
			return resolveDataFunction(getDataFunctionReferenceId(reference)) || reference
		},
	})
}

export function resetDataFunctionReferences() {
	referenceByFunction = new WeakMap()
	functionByReference.clear()
}
