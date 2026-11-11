import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({ invokeAPI: vi.fn() }))

import { invokeAPI } from '@/api/common'
import { request } from '../src/api/core/network/request/index.js'

function dispatched(options) {
	request(options)
	return vi.mocked(invokeAPI).mock.calls.at(-1)[1]
}

describe('request query parameters (#341)', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
	})

	it.each([undefined, 'GET', 'HEAD', 'DELETE', 'get', 'head', 'delete'])('serializes object data for method %s before invoking the host', (method) => {
		const params = dispatched({
			url: 'https://example.com/GetEmployeeBill', method,
			data: { dateBegin: '2026-09', transType: '20,30,40', pageIndex: 1, pageSize: 10 },
		})
		expect(params.url).toBe('https://example.com/GetEmployeeBill?dateBegin=2026-09&transType=20%2C30%2C40&pageIndex=1&pageSize=10')
		expect(params).not.toHaveProperty('data')
		expect(params.method).toBe((method || 'GET').toUpperCase())
	})

	it.each([
		['https://example.com/api?old=a%2Cb#section?x', 'https://example.com/api?old=a%2Cb&key=value#section?x'],
		['https://example.com/api#section', 'https://example.com/api?key=value#section'],
		['https://example.com/api?', 'https://example.com/api?key=value'],
		['https://example.com/api?old=1&', 'https://example.com/api?old=1&key=value'],
	])('appends to %s without rewriting existing query or fragment', (url, expected) => {
		expect(dispatched({ url, data: { key: 'value' } }).url).toBe(expected)
	})

	it('encodes keys and values, repeats array keys and skips nullish values', () => {
		const params = dispatched({ url: 'https://example.com', data: {
			'a &': '中文 +#=?%', list: ['20,30', null, undefined, 0, false, ''],
			empty: [], absent: undefined, nil: null, zero: 0, bool: false, blank: '',
		} })
		expect(params.url).toBe('https://example.com?a%20%26=%E4%B8%AD%E6%96%87%20%2B%23%3D%3F%25&list=20%2C30&list=0&list=false&list=&zero=0&bool=false&blank=')
	})

	it.each([{}, { nil: null, absent: undefined }, { list: [] }])('removes empty object payload %j without appending a separator', (data) => {
		const params = dispatched({ url: 'https://example.com/api#fragment', data })
		expect(params.url).toBe('https://example.com/api#fragment')
		expect(params).not.toHaveProperty('data')
	})

	it('uses only own enumerable keys', () => {
		const data = Object.assign(Object.create({ inherited: 'no' }), { own: 'yes' })
		expect(dispatched({ url: 'https://example.com', data }).url).toBe('https://example.com?own=yes')
	})

	it('preserves caller options, callbacks, headers and the host return value', () => {
		const success = vi.fn()
		const header = Object.freeze({ Authorization: 'Bearer test' })
		const data = Object.freeze({ key: 'value' })
		const options = Object.freeze({ url: 'https://example.com', data, header, success, timeout: 1000 })
		const task = { abort: vi.fn() }
		vi.mocked(invokeAPI).mockReturnValue(task)
		expect(request(options)).toBe(task)
		expect(invokeAPI).toHaveBeenCalledWith('request', {
			url: 'https://example.com?key=value', method: 'GET', header, success, timeout: 1000,
		})
		expect(options.data).toBe(data)
		expect(options.url).toBe('https://example.com')
	})

	it.each(['POST', 'PUT', 'PATCH'])('preserves %s body data', (method) => {
		const options = { url: 'https://example.com', method, data: { key: 'value' } }
		expect(dispatched(options)).toEqual(options)
	})

	it.each([undefined, null, 'key=value'])('preserves non-object query payload %s', (data) => {
		const options = { url: 'https://example.com', method: 'GET', data }
		expect(dispatched(options)).toEqual(options)
	})
})
