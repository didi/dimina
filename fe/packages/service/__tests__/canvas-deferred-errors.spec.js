import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { createOffscreenCanvas } from '../src/api/core/ui/canvas/index.js'

let serial = 0
let bridgeId
let invoke
const canvases = []
beforeEach(() => {
	bridgeId = `deferred-page-${serial++}`
	router.setInitId(bridgeId)
	invoke = globalThis.DiminaServiceBridge.invoke
	globalThis.DiminaServiceBridge.canvasSyncSupported = true
	globalThis.DiminaServiceBridge.invoke = vi.fn(() => ({ contexts: {}, typedArrays: [] }))
	globalThis.DiminaServiceBridge.publish = vi.fn()
})
afterEach(() => {
	for (const canvas of canvases.splice(0)) canvas.dispose()
	globalThis.DiminaServiceBridge.onMessage({ type: 'pageUnload', body: { bridgeId } })
	delete globalThis.DiminaServiceBridge.canvasSyncSupported
	globalThis.DiminaServiceBridge.invoke = invoke
})
function create(deferredGLErrors, announcedBridge = bridgeId) {
	globalThis.DiminaServiceBridge.onMessage({ type: 'canvasCapabilities', body: {
		bridgeId: announcedBridge, capabilities: { webgl: { supported: true }, deferredGLErrors },
	} })
	const canvas = createOffscreenCanvas({ type: 'webgl' })
	canvases.push(canvas)
	return canvas.getContext('webgl')
}
function packet() { return globalThis.DiminaServiceBridge.invoke.mock.calls.at(-1)[0].body.params }

describe('deferred GL error capability gate', () => {
	it('opts in only to the same renderer bridge advertising literal true', () => {
		for (const value of [undefined, false, 'true']) {
			const gl = create(value)
			gl.getError()
			expect(packet().deferErrorFeedback).toBeUndefined()
		}
		create(true).getError()
		expect(packet().deferErrorFeedback).toBe(true)
	})

	it('does not use another page capability and keeps an explicit real error query', () => {
		const gl = create(true, `${bridgeId}-other`)
		gl.getError()
		expect(packet().deferErrorFeedback).toBeUndefined()
		expect(packet().operations).toEqual([{ op: 'contextFeedback', contextId: expect.any(String) }])
	})

	it('does not enqueue another error poll after the synchronous NO_ERROR result', async () => {
		const gl = create(true)
		globalThis.DiminaServiceBridge.invoke.mockClear()
		globalThis.DiminaServiceBridge.publish.mockClear()
		expect(gl.getError()).toBe(gl.NO_ERROR)
		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledOnce()
		await Promise.resolve()
		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledOnce()
		expect(globalThis.DiminaServiceBridge.publish).not.toHaveBeenCalled()
	})

	it('retains real createBuffer null and synchronous isContextLost query', () => {
		const gl = create(true)
		globalThis.DiminaServiceBridge.invoke = vi.fn(({ body }) => {
			const contexts = {}
			for (const op of body.params.operations) {
				const result = contexts[op.contextId] ||= {}
				if (op.feedback === 'resource') (result.resources ||= []).push({ resourceId: op.resultId, metadata: { created: false } })
				if (op.op === 'contextQuery') (result.queries ||= []).push({ key: op.key, value: op.method === 'isContextLost' })
			}
			return { contexts, typedArrays: [] }
		})
		expect(gl.createBuffer()).toBeNull()
		expect(packet().deferErrorFeedback).toBe(true)
		expect(gl.isContextLost()).toBe(true)
		expect(packet().operations[0].method).toBe('isContextLost')
	})

	it('deduplicates real backend flags while returning each pending error once', () => {
		const gl = create(true)
		let first = true
		globalThis.DiminaServiceBridge.invoke = vi.fn(({ body }) => {
			const id = body.params.operations[0].contextId
			const errors = first ? [0x501, 0x501, 0x500] : []
			first = false
			return { contexts: { [id]: { errors } }, typedArrays: [] }
		})
		expect(gl.getError()).toBe(gl.INVALID_VALUE)
		expect(gl.getError()).toBe(gl.INVALID_ENUM)
		expect(gl.getError()).toBe(gl.NO_ERROR)
	})

	it('clears pre-restoration feedback errors and query caches when the context is restored', () => {
		const gl = create(true), canvas = canvases.at(-1)
		let first = true
		globalThis.DiminaServiceBridge.invoke = vi.fn(({ body }) => {
			const id = body.params.operations[0].contextId
			const errors = first ? [0x501, 0x500] : []
			first = false
			return { contexts: { [id]: { errors } }, typedArrays: [] }
		})
		expect(gl.getError()).toBe(gl.INVALID_VALUE)
		const contextId = packet().operations[0].contextId
		globalThis.DiminaServiceBridge.onMessage({ type: 'canvasContextEvent', body: {
			bridgeId, nodeId: canvas.nodeId, type: 'webglcontextrestored', contexts: { [contextId]: { contextLost: false } },
		} })
		expect(gl.getError()).toBe(gl.NO_ERROR)
	})
})
