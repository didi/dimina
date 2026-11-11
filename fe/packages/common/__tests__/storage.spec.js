import { describe, expect, it } from 'vitest'
import { checkStorageQuota, createStorageEntry, decodeStorageEntry, decodeStorageResult, STORAGE_LIMIT, storageEntrySize, storageSpaceSize } from '../src/core/storage'

describe('typed storage wire format', () => {
	it.each([
		['string', '你😀"\\\n'], ['number', -0], ['nan', Number.NaN], ['infinity', Infinity],
		['boolean', false], ['date', new Date(1700000000000)], ['invalid date', new Date(Number.NaN)],
		['undefined', undefined], ['null', null], ['array', [1, undefined, null]],
		['object', { a: true, nested: ['你😀'], missing: undefined }],
	])('serializes and decodes %s without relying on the bridge JSON type', (_, value) => {
		const record = createStorageEntry('key', value)
		const expected = Array.isArray(value) || (value?.constructor === Object)
			? JSON.parse(JSON.stringify(value)) : Object.is(value, -0) ? 0 : value
		expect(decodeStorageEntry(JSON.parse(JSON.stringify(record)))).toEqual(expected)
	})

	it('uses the reference empty string for unsupported values', () => {
		for (const value of [() => {}, /abc/, new Map(), new Set(), Symbol('s')]) {
			expect(decodeStorageEntry(createStorageEntry('key', value))).toBe('')
		}
	})

	it('measures the serialized logical namespace in UTF-16, including escaping and separators', () => {
		const space = Object.fromEntries([
			['键😀', '你好😀"\\\n\u0000'], ['second', { a: [1, true, null] }], ['', 3],
		].map(([key, value]) => { const { data, dataType } = createStorageEntry(key, value); return [key, { data, dataType }] }))
		const sizes = Object.entries(space).map(([key, record]) => storageEntrySize(key, record))
		expect(storageSpaceSize(sizes)).toBe(JSON.stringify(space).length)
		expect(storageSpaceSize([])).toBe(2)
	})

	it('accepts the exact 10 MB namespace boundary and rejects one more UTF-16 unit', () => {
		const overhead = storageSpaceSize([createStorageEntry('k', '').entrySize]) + 6
		const size = createStorageEntry('k', 'x'.repeat(STORAGE_LIMIT - overhead)).entrySize
		expect(() => checkStorageQuota([size])).not.toThrow()
		expect(() => checkStorageQuota([size + 1])).toThrow('exceed storage max size 10Mb')
	})

	it('unwraps only explicit bridge envelopes and preserves legacy data', () => {
		const value = { data: 'user data', dataType: 'String' }
		expect(decodeStorageResult(value)).toBe(value)
		expect(decodeStorageResult({ __diminaStorageResult: 1, value })).toBe(value)
		expect(decodeStorageResult({ __diminaStorageResult: 1, record: createStorageEntry('k', false) })).toBe(false)
	})
})
