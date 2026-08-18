import { describe, expect, it } from 'vitest'
import {
	createDataFunctionReference,
	getDataFunctionReferenceId,
	isDataFunctionReference,
	transformDataFunctions,
} from '../src/core/data-function'

describe('data function bridge references', () => {
	it('transforms nested functions without changing their identity mapping', () => {
		const fn = () => 'value'
		const references = new WeakMap()
		const encoded = transformDataFunctions({ fn, list: [fn] }, {
			mapFunction(value) {
				if (!references.has(value)) {
					references.set(value, 'function-1')
				}
				return createDataFunctionReference(references.get(value))
			},
		})

		expect(isDataFunctionReference(encoded.fn)).toBe(true)
		expect(getDataFunctionReferenceId(encoded.fn)).toBe('function-1')
		expect(encoded.list[0]).toEqual(encoded.fn)

		const decoded = transformDataFunctions(encoded, {
			mapReference: () => fn,
		})
		expect(decoded.fn).toBe(fn)
		expect(decoded.list[0]).toBe(fn)
	})

	it('preserves bridge-supported object values and cyclic references', () => {
		const date = new Date('2025-01-02T03:04:05.000Z')
		const value = { date }
		value.self = value

		const transformed = transformDataFunctions(value)

		expect(transformed.date).toBe(date)
		expect(transformed.self).toBe(transformed)
	})
})
