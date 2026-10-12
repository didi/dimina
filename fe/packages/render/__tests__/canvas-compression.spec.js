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
