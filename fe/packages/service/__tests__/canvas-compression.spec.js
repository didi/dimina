import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { createOffscreenCanvas } from '../src/api/core/ui/canvas/index.js'
import { resetMiniGameCanvas } from '../src/api/core/ui/canvas/canvas-node.js'

describe('negotiated canvas typed array encoding', () => {
	let originalInvoke
	const canvases = []
	beforeEach(() => {
		resetMiniGameCanvas()
		router.setInitId('compression-page')
		originalInvoke = globalThis.DiminaServiceBridge.invoke
		globalThis.DiminaServiceBridge.canvasSyncSupported = true
		globalThis.DiminaServiceBridge.invoke = vi.fn(() => ({ contexts: {}, typedArrays: [] }))
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})
	afterEach(() => {
		for (const canvas of canvases.splice(0)) canvas.dispose()
		delete globalThis.DiminaServiceBridge.canvasSyncSupported
		delete globalThis.DiminaServiceBridge.encodeCanvasArrayBuffer
		globalThis.DiminaServiceBridge.invoke = originalInvoke
	})
	function create(encodings) {
		globalThis.DiminaServiceBridge.onMessage({ type: 'canvasCapabilities', body: {
			bridgeId: 'compression-page', capabilities: {
				webgl: { supported: true }, typedArrayEncodings: encodings,
			},
		} })
		const canvas = createOffscreenCanvas({ type: 'webgl' })
		canvases.push(canvas)
		return canvas.getContext('webgl')
	}
	function flush(gl, pixels) {
		gl.bufferData(gl.ARRAY_BUFFER, pixels, gl.STATIC_DRAW)
		gl.getError()
		return globalThis.DiminaServiceBridge.invoke.mock.calls.at(-1)[0].body.params.operations
			.find(op => op.method === 'bufferData').args[1]
	}

	it('keeps the original codec when an older renderer does not advertise compression', () => {
		const encode = vi.fn()
		globalThis.DiminaServiceBridge.encodeCanvasArrayBuffer = encode
		const descriptor = flush(create(undefined), new Uint8Array(64 * 1024).fill(7))
		expect(encode).not.toHaveBeenCalled()
		expect(descriptor).toMatchObject({ __canvasTypedArray: 'Uint8Array', base64: expect.any(String) })
		expect(descriptor.encoding).toBeUndefined()
	})

	it('keeps the original codec on containers without the native encoder', () => {
		const descriptor = flush(create(['rle32-v1']), new Uint8Array(64 * 1024).fill(9))
		expect(descriptor).toMatchObject({ __canvasTypedArray: 'Uint8Array', base64: expect.any(String) })
		expect(descriptor.encoding).toBeUndefined()
	})

	it('passes the exact view snapshot to the native codec before later user mutations', () => {
		const encode = vi.fn(buffer => ({ base64: Buffer.from(buffer).toString('base64') }))
		globalThis.DiminaServiceBridge.encodeCanvasArrayBuffer = encode
		const gl = create(['rle32-v1'])
		const storage = new Uint8Array(65544).fill(255)
		const pixels = storage.subarray(4, 65540)
		pixels.fill(23)
		gl.bufferData(gl.ARRAY_BUFFER, pixels, gl.STATIC_DRAW)
		pixels.fill(99)
		gl.getError()
		const descriptor = globalThis.DiminaServiceBridge.invoke.mock.calls.at(-1)[0].body.params.operations
			.find(op => op.method === 'bufferData').args[1]
		expect(encode).toHaveBeenCalledOnce()
		const snapshot = new Uint8Array(encode.mock.calls[0][0])
		expect(snapshot.length).toBe(65536)
		expect(snapshot.every(byte => byte === 23)).toBe(true)
		expect([...Buffer.from(descriptor.base64, 'base64')].every(byte => byte === 23)).toBe(true)
	})

	it('retains the negotiated encoding and original typed array kind in the wire descriptor', () => {
		globalThis.DiminaServiceBridge.encodeCanvasArrayBuffer = vi.fn(buffer => ({
			base64: 'AQAAiBIAAAA=', encoding: 'rle32-v1', byteLength: buffer.byteLength,
		}))
		const descriptor = flush(create(['rle32-v1']), new Float32Array(16384).fill(1.5))
		expect(descriptor).toEqual({ __canvasTypedArray: 'Float32Array', base64: 'AQAAiBIAAAA=',
			encoding: 'rle32-v1', byteLength: 65536 })
	})
})
