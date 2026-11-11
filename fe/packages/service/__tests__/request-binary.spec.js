import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let request, callback, bridge

beforeEach(async () => {
	vi.resetModules()
	bridge = { invoke: vi.fn(), publish: vi.fn() }
	vi.stubGlobal('DiminaServiceBridge', bridge)
	vi.stubGlobal('__diminaDebug', false)
	;({ request } = await import('../src/api/core/network/request/index.js'))
	;({ callback } = await import('@dimina/common'))
})

afterEach(() => { vi.unstubAllGlobals() })

const marker = '__diminaArrayBufferBase64'
const bytes = [0, 255, 128, 195, 40, 13, 10]
const encoded = Buffer.from(bytes).toString('base64')

describe('request binary bridge', () => {
	it('preserves arbitrary response bytes in both success and complete after JSON transport', () => {
		const success = vi.fn(), complete = vi.fn()
		const task = { abort: vi.fn() }
		bridge.invoke.mockReturnValue(task)
		expect(request({ url: 'https://example.com', responseType: 'arraybuffer', success, complete })).toBe(task)
		const params = JSON.parse(JSON.stringify(bridge.invoke.mock.calls[0][0].body.params))
		const response = { errMsg: 'request:ok', statusCode: 503, header: {}, data: { [marker]: encoded } }
		callback.invoke(params.success, JSON.parse(JSON.stringify(response)))
		callback.invoke(params.complete, JSON.parse(JSON.stringify(response)))
		for (const fn of [success, complete]) {
			expect(fn).toHaveBeenCalledTimes(1)
			const result = fn.mock.calls[0][0]
			expect(result.statusCode).toBe(503)
			expect(result.data).toBeInstanceOf(ArrayBuffer)
			expect([...new Uint8Array(result.data)]).toEqual(bytes)
		}
	})

	it.each([
		() => new Uint8Array(bytes).buffer,
		() => new Uint8Array([99, ...bytes, 99]).subarray(1, bytes.length + 1),
		() => new DataView(new Uint8Array([99, ...bytes, 99]).buffer, 1, bytes.length),
	])('serializes only the supplied request buffer segment', (create) => {
		const data = create()
		const options = Object.freeze({ url: 'https://example.com', method: 'POST', data })
		request(options)
		const params = JSON.parse(JSON.stringify(bridge.invoke.mock.calls[0][0].body.params))
		expect(params.data).toEqual({ [marker]: encoded })
		expect(options.data).toBe(data)
	})

	it('keeps empty response buffers and native browser ArrayBuffers', () => {
		const success = vi.fn()
		request({ url: 'https://example.com', responseType: 'ARRAYBUFFER', success })
		const params = bridge.invoke.mock.calls[0][0].body.params
		callback.invoke(params.success, { data: { [marker]: '' } })
		expect(success.mock.calls[0][0].data.byteLength).toBe(0)
		const direct = new Uint8Array(bytes).buffer
		request({ url: 'https://example.com', responseType: 'arraybuffer', success })
		callback.invoke(bridge.invoke.mock.calls[1][0].body.params.success, { data: direct })
		expect(success.mock.calls[1][0].data).toBe(direct)
	})

	it('does not interpret ordinary JSON response data as binary', () => {
		const success = vi.fn()
		request({ url: 'https://example.com', success })
		callback.invoke(bridge.invoke.mock.calls[0][0].body.params.success, { data: { [marker]: encoded } })
		expect(success.mock.calls[0][0].data).toEqual({ [marker]: encoded })
	})
})
