import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { createTCPSocket } from '../src/api/core/network/tcp/index.js'
import { createUDPSocket } from '../src/api/core/network/udp/index.js'
import { canIUse } from '../src/api/core/base/index.js'

function bytes(buffer) {
	return Array.from(new Uint8Array(buffer))
}

describe('local network socket service adapters', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('binds UDP synchronously and returns the native port', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce(54321)
		const socket = createUDPSocket()

		expect(socket.bind()).toBe(54321)
		expect(invokeAPI).toHaveBeenCalledWith('UDPSocket.bind', expect.objectContaining({
			port: 0,
			keep: true,
		}))
	})

	it('encodes UDP and TCP ArrayBuffer payloads', () => {
		const udp = createUDPSocket()
		udp.send({ address: '192.168.1.2', port: 9000, message: new Uint8Array([1, 2, 3]).buffer })
		const tcp = createTCPSocket()
		tcp.write(new Uint8Array([4, 5]).buffer)

		expect(invokeAPI).toHaveBeenNthCalledWith(1, 'UDPSocket.send', expect.objectContaining({
			message: { __diminaArrayBufferBase64: 'AQID' },
		}))
		expect(invokeAPI).toHaveBeenNthCalledWith(2, 'TCPSocket.write', expect.objectContaining({
			data: { __diminaArrayBufferBase64: 'BAU=' },
		}))
	})

	it('shares one native subscription and decodes UDP messages', () => {
		const socket = createUDPSocket()
		const first = vi.fn()
		const second = vi.fn()
		socket.onMessage(first)
		socket.onMessage(second)

		expect(invokeAPI).toHaveBeenCalledTimes(1)
		const params = vi.mocked(invokeAPI).mock.calls[0][1]
		callback.invoke(params.callbackId, { message: { __diminaArrayBufferBase64: 'Bgc=' } })

		expect(bytes(first.mock.calls[0][0].message)).toEqual([6, 7])
		expect(bytes(second.mock.calls[0][0].message)).toEqual([6, 7])
	})

	it('removes native subscription only after the last listener', () => {
		const socket = createTCPSocket()
		const first = vi.fn()
		const second = vi.fn()
		socket.onError(first)
		socket.onError(second)
		socket.offError(first)
		expect(invokeAPI).toHaveBeenCalledTimes(1)

		socket.offError(second)
		expect(invokeAPI).toHaveBeenLastCalledWith('TCPSocket.offError', expect.objectContaining({
			socketId: socket.socketId,
			keep: true,
		}))
	})

	it('creates distinct native socket identifiers', () => {
		expect(createUDPSocket().socketId).not.toBe(createUDPSocket().socketId)
		expect(createTCPSocket().socketId).not.toBe(createTCPSocket().socketId)
	})

	it('keeps the close listener alive until the native close event arrives', () => {
		const socket = createUDPSocket()
		const listener = vi.fn()
		socket.onClose(listener)
		const callbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId

		socket.close()
		callback.invoke(callbackId, {})

		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('probes native object support for socket factories', () => {
		vi.mocked(invokeAPI).mockReturnValue(true)

		expect(canIUse('createUDPSocket')).toBe(true)
		expect(canIUse('createTCPSocket')).toBe(true)
		expect(invokeAPI).toHaveBeenNthCalledWith(1, 'canIUse', 'UDPSocket.bind')
		expect(invokeAPI).toHaveBeenNthCalledWith(2, 'canIUse', 'TCPSocket.connect')
	})

	it('returns false when the host has no synchronous capability result', () => {
		vi.mocked(invokeAPI).mockReturnValue(undefined)

		expect(canIUse('createUDPSocket')).toBe(false)
		expect(canIUse('createTCPSocket')).toBe(false)
		expect(canIUse('unknown.schema')).toBe(false)
	})
})
