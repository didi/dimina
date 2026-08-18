import {
	createDataFunctionReference,
	getDataFunctionReferenceId,
	transformDataFunctions,
} from '@dimina/common'

const proxyByReference = new Map()

function getDataFunctionProxy(reference) {
	if (proxyByReference.has(reference)) {
		return proxyByReference.get(reference)
	}

	// WXML does not invoke functions from data. The proxy preserves Function
	// identity and serializes back to the same reference for component bindings.
	const proxy = function dataFunctionReference() {}
	Object.defineProperty(proxy, 'toJSON', {
		value: () => createDataFunctionReference(reference),
	})
	proxyByReference.set(reference, proxy)
	return proxy
}

export function decodeDataFunctions(value) {
	return transformDataFunctions(value, {
		mapReference(dataFunctionReference) {
			return getDataFunctionProxy(getDataFunctionReferenceId(dataFunctionReference))
		},
	})
}

export function resetDataFunctionProxies() {
	proxyByReference.clear()
}
