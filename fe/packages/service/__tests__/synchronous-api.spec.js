import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeSynchronousAPI } from '../src/core/synchronous-api'

const message = { type: 'invokeAPI', target: 'container', body: { name: 'getStorageSync', params: { key: 'value' } } }

afterEach(() => vi.unstubAllGlobals())

function configure(endpoint = 'http://127.0.0.1:9000/private/sync') {
	vi.stubGlobal('name', JSON.stringify({ synchronousApiUrl: endpoint }))
	vi.stubGlobal('location', { href: 'http://127.0.0.1:9000/private/service.js', origin: 'http://127.0.0.1:9000' })
}

describe('desktop Worker synchronous API transport', () => {
	it('leaves existing hosts and asynchronous calls on their original bridge', () => {
		vi.stubGlobal('name', '{}')
		expect(invokeSynchronousAPI(message)).toEqual({ handled: false })
		configure()
		expect(invokeSynchronousAPI({ ...message, body: { name: 'getStorage' } })).toEqual({ handled: false })
	})
	it('returns the host result before the caller continues', () => {
		configure()
		const open = vi.fn()
		const send = vi.fn()
		vi.stubGlobal('XMLHttpRequest', class {
			status = 200
			responseText = JSON.stringify({ value: { __diminaStorageResult: 1, record: { data: 'true', dataType: 'Boolean' } } })
			open = open
			setRequestHeader() {}
			send = send
		})
		expect(invokeSynchronousAPI(message)).toEqual({ handled: true, value: { __diminaStorageResult: 1, record: { data: 'true', dataType: 'Boolean' } } })
		expect(open).toHaveBeenCalledWith('POST', 'http://127.0.0.1:9000/private/sync', false)
		expect(JSON.parse(send.mock.calls[0][0])).toEqual({ name: 'getStorageSync', params: { key: 'value' } })
	})

	it('throws host write failures instead of reporting a successful synchronous write', () => {
		configure()
		vi.stubGlobal('XMLHttpRequest', class {
			status = 400
			responseText = '{"error":"disk full"}'
			open() {}
			setRequestHeader() {}
			send() {}
		})
		expect(() => invokeSynchronousAPI(message)).toThrow('getStorageSync:fail disk full')
	})

	it('rejects cross-origin endpoints before creating an XMLHttpRequest', () => {
		configure('https://example.com/storage')
		const xhr = vi.fn()
		vi.stubGlobal('XMLHttpRequest', xhr)
		expect(() => invokeSynchronousAPI(message)).toThrow('same-origin')
		expect(xhr).not.toHaveBeenCalled()
	})
})

it.each(['UDPSocket.bind', 'UDPSocket.onListening', 'UDPSocket.send', 'TCPSocket.onConnect', 'TCPSocket.connect', 'canIUse'])('orders desktop %s with native subscriptions and returns the result synchronously', (name) => {
	configure()
	vi.stubGlobal('XMLHttpRequest', class {
		status = 200
		responseText = '{"value":12345}'
		open(_method, _url, async) { expect(async).toBe(false) }
		setRequestHeader() {}
		send() {}
	})
	expect(invokeSynchronousAPI({ ...message, body: { name, params: { socketId: 'udp' } } })).toEqual({ handled: true, value: 12345 })
})
