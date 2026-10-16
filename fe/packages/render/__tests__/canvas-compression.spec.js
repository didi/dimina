import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime.js'

function descriptor(type = 'Uint8Array') {
	const data = new ArrayBuffer(20)
	const view = new DataView(data)
	for (const [index, word] of [0x80000003, 0x3f800000, 2, 0x7fc000a5, 0xffffffff].entries()) {
		view.setUint32(index * 4, word, true)
	}
	return { __canvasTypedArray: type, base64: Buffer.from(data).toString('base64'),
		encoding: 'rle32-v1', byteLength: 20 }
}

describe('compressed canvas arguments', () => {
	it('preserves float bit patterns and DataView bytes when constructing renderer views', () => {
		const floats = runtime.resolveCanvasArg(descriptor('Float32Array'))
		expect([...new Uint32Array(floats.buffer)]).toEqual([0x3f800000, 0x3f800000, 0x3f800000, 0x7fc000a5, 0xffffffff])
		const view = runtime.resolveCanvasArg(descriptor('DataView'))
		expect(view.byteLength).toBe(20)
		expect(view.getUint32(12, true)).toBe(0x7fc000a5)
	})

	it('executes a following GL query after the exact decompressed upload', () => {
		const calls = []
		const gl = { bufferData: (_target, bytes) => calls.push([...bytes]),
			getBufferParameter: () => calls.length, getError: () => 0, NO_ERROR: 0 }
		const node = { nodeId: 'compressed-node', bridgeId: 'compressed-page', contexts: new Map([['compressed-gl', gl]]) }
		runtime.canvasNodes.set(node.nodeId, node)
		runtime.canvasResources.set('compressed-gl', gl)
		try {
			const result = runtime.canvasNodeFlush({ bridgeId: node.bridgeId, synchronous: true, params: {
				nodeId: node.nodeId, feedback: true, operations: [
					{ op: 'contextCall', contextId: 'compressed-gl', method: 'bufferData', args: [0x8892, descriptor()] },
					{ op: 'contextQuery', contextId: 'compressed-gl', method: 'getBufferParameter', key: 'uploaded', args: [] },
				],
			} })
			expect(calls).toEqual([[0, 0, 128, 63, 0, 0, 128, 63, 0, 0, 128, 63, 165, 0, 192, 127, 255, 255, 255, 255]])
			expect(result.contexts['compressed-gl'].queries[0]).toMatchObject({ key: 'uploaded', value: 1 })
		} finally {
			runtime.canvasNodes.delete(node.nodeId)
			runtime.canvasResources.delete('compressed-gl')
		}
	})

	it('reports corrupt texture arguments through the operation failure callback before any GL upload', () => {
		const gl = { texImage2D: vi.fn(), getError: () => 0, NO_ERROR: 0 }
		const node = { nodeId: 'corrupt-node', bridgeId: 'corrupt-page', contexts: new Map([['corrupt-gl', gl]]) }
		const callback = vi.spyOn(runtime, 'triggerCallback').mockImplementation(() => {})
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
		runtime.canvasNodes.set(node.nodeId, node)
		runtime.canvasResources.set('corrupt-gl', gl)
		try {
			runtime.canvasNodeFlush({ bridgeId: node.bridgeId, synchronous: true, params: {
				nodeId: node.nodeId, operations: [{ op: 'contextCall', contextId: 'corrupt-gl', method: 'texImage2D',
					args: [0xDE1, 0, 0x1908, 1, 5, 0, 0x1908, 0x1401, { ...descriptor(), byteLength: 24 }],
					callback: 'bad-upload', resultEnvelope: true }],
			} })
			expect(gl.texImage2D).not.toHaveBeenCalled()
			expect(callback).toHaveBeenCalledWith(node.bridgeId, 'bad-upload', { ok: false, error: expect.stringMatching(/smaller than its declared size/) })
		} finally {
			callback.mockRestore(); warning.mockRestore()
			runtime.canvasNodes.delete(node.nodeId); runtime.canvasResources.delete('corrupt-gl')
		}
	})

	it('preserves exact unaligned packed bytes and original Float32 bit patterns', () => {
		const raw = new Uint32Array([0x7FC000A5, 0x80000000, 0xFFFFFFFF])
		const storage = new Uint8Array(raw.byteLength + 6).fill(17)
		storage.set(new Uint8Array(raw.buffer), 3)
		const value = runtime.resolveCanvasArg({ __canvasTypedArray: 'Float32Array', packed: storage.subarray(3, -3) })
		storage.fill(99)
		expect([...new Uint32Array(value.buffer)]).toEqual([0x7FC000A5, 0x80000000, 0xFFFFFFFF])
		expect(value.byteLength).toBe(raw.byteLength)
	})

	it('decodes packed RLE descriptors through the same validated bit-exact fallback', () => {
		const original = descriptor('Float32Array')
		const packed = new Uint8Array(Buffer.from(original.base64, 'base64'))
		const value = runtime.resolveCanvasArg({ ...original, base64: undefined, packed })
		expect([...new Uint32Array(value.buffer)]).toEqual([0x3F800000, 0x3F800000, 0x3F800000, 0x7FC000A5, 0xFFFFFFFF])
	})

	it('rejects unknown encodings instead of sending encoded data to GL', () => {
		expect(() => runtime.resolveCanvasArg({ ...descriptor(), encoding: 'unknown' })).toThrow(/unsupported/)
	})

	it('advertises compression alongside the existing context capabilities', () => {
		const previous = runtime.canvasCapabilities
		runtime.canvasCapabilities = null
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
		try {
			const capabilities = runtime.getCanvasCapabilities()
			expect(capabilities.typedArrayEncodings).toEqual(['rle32-v1'])
			expect(capabilities.webgl.supported).toBe(false)
		} finally {
			getContext.mockRestore()
			runtime.canvasCapabilities = previous
		}
	})
})
