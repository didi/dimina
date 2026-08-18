import { getDataFunctionReferenceId, isDataFunctionReference } from '@dimina/common'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	decodeDataFunctions,
	encodeDataFunctions,
	resetDataFunctionReferences,
	resolveDataFunction,
} from '../src/core/data-function'

describe('service data function references', () => {
	beforeEach(() => {
		resetDataFunctionReferences()
	})

	it('restores original functions after a JSON bridge round trip', () => {
		const fn = () => 'value'
		const encoded = encodeDataFunctions({ fn, list: [fn] })
		const bridged = JSON.parse(JSON.stringify(encoded))
		const reference = getDataFunctionReferenceId(bridged.fn)

		expect(isDataFunctionReference(bridged.fn)).toBe(true)
		expect(bridged.list[0]).toEqual(bridged.fn)
		expect(resolveDataFunction(reference)).toBe(fn)
		expect(decodeDataFunctions(bridged)).toEqual({ fn, list: [fn] })
	})
})
