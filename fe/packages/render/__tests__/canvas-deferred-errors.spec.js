import { afterEach, describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime.js'
import message from '../src/core/message.js'

const nodes = []
function mount(contexts) {
	const nodeId = `deferred-node-${nodes.length}`
	const node = { nodeId, bridgeId: 'deferred-page', canvas: document.createElement('canvas'), contexts: new Map(contexts) }
	runtime.canvasNodes.set(nodeId, node)
	for (const [id, gl] of contexts) runtime.canvasResources.set(id, gl)
	nodes.push(node)
	return (operations, deferErrorFeedback) => runtime.canvasNodeFlush({ bridgeId: node.bridgeId, synchronous: true,
		params: { nodeId, feedback: true, operations, ...(deferErrorFeedback === undefined ? {} : { deferErrorFeedback }) } })
}
function stickyGL() {
	const errors = new Set()
	let lost = false
	return {
		NO_ERROR: 0, errors,
		createBuffer: vi.fn(() => lost ? null : {}),
		bufferData: vi.fn(() => { if (!lost) errors.add(0x501) }),
		getBufferParameter: vi.fn(() => 23),
		getError: vi.fn(() => { const value = errors.values().next().value || 0; errors.delete(value); return value }),
		isContextLost: vi.fn(() => lost),
		getSupportedExtensions: () => [],
		lose() { lost = true; errors.clear(); errors.add(0x9242) },
		restore() { lost = false; errors.clear() },
	}
}
afterEach(() => {
	for (const node of nodes.splice(0)) {
		node.contextEventCleanup?.()
		runtime.canvasNodes.delete(node.nodeId)
		for (const id of node.contexts.keys()) runtime.canvasResources.delete(id)
	}
	vi.restoreAllMocks()
})

describe('negotiated deferred WebGL errors', () => {
	it('keeps legacy batch error collection when the flag is absent or false', () => {
		for (const flag of [undefined, false]) {
			const gl = stickyGL(), flush = mount([['legacy-gl', gl]])
			const result = flush([{ op: 'contextCall', contextId: 'legacy-gl', method: 'bufferData', args: [] }], flag)
			expect(result.contexts['legacy-gl'].errors).toEqual([0x501])
			expect(gl.getError).toHaveBeenCalledTimes(2)
		}
	})

	it('executes real creation and queries without draining sticky flags before the explicit error query', () => {
		const gl = stickyGL(), flush = mount([['deferred-gl', gl]])
		const result = flush([
			{ op: 'contextCall', contextId: 'deferred-gl', method: 'bufferData', args: [] },
			{ op: 'contextCall', contextId: 'deferred-gl', method: 'createBuffer', args: [], resultId: 'new-buffer', feedback: 'resource' },
			{ op: 'contextQuery', contextId: 'deferred-gl', method: 'getBufferParameter', args: [], key: 'actual' },
		], true)
		expect(gl.createBuffer).toHaveBeenCalledOnce()
		expect(gl.getError).not.toHaveBeenCalled()
		expect(gl.isContextLost).not.toHaveBeenCalled()
		expect(result.contexts['deferred-gl'].resources[0].metadata.created).toBe(true)
		expect(result.contexts['deferred-gl'].queries[0].value).toBe(23)
		expect(gl.errors.has(0x501)).toBe(true)
		const errors = flush([{ op: 'contextFeedback', contextId: 'deferred-gl' }], true)
		expect(errors.contexts['deferred-gl'].errors).toEqual([0x501])
		expect(flush([{ op: 'contextFeedback', contextId: 'deferred-gl' }], true).contexts['deferred-gl'].errors).toBeUndefined()
		runtime.canvasResources.delete('new-buffer')
	})

	it('collects only the context whose explicit error query was included', () => {
		const a = stickyGL(), b = stickyGL(), flush = mount([['gl-a', a], ['gl-b', b]])
		a.errors.add(0x500); b.errors.add(0x501)
		const result = flush([
			{ op: 'contextQuery', contextId: 'gl-b', method: 'getBufferParameter', args: [], key: 'b' },
			{ op: 'contextFeedback', contextId: 'gl-a' },
		], true)
		expect(result.contexts['gl-a'].errors).toEqual([0x500])
		expect(b.getError).not.toHaveBeenCalled()
		expect(b.errors.has(0x501)).toBe(true)
	})

	it('keeps null creation and one context-loss error, and forwards loss/restoration events', () => {
		const gl = stickyGL(), flush = mount([['lost-gl', gl]]), node = nodes.at(-1)
		const send = vi.spyOn(message, 'send').mockImplementation(() => {})
		runtime.observeWebGLContextEvents(node)
		gl.lose()
		node.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
		expect(send.mock.calls.at(-1)[0].body.contexts['lost-gl'].contextLost).toBe(true)
		const created = flush([{ op: 'contextCall', contextId: 'lost-gl', method: 'createBuffer', args: [], resultId: 'lost-buffer', feedback: 'resource' }], true)
		expect(created.contexts['lost-gl'].resources[0].metadata.created).toBe(false)
		expect(flush([{ op: 'contextFeedback', contextId: 'lost-gl' }], true).contexts['lost-gl'].errors).toEqual([0x9242])
		expect(flush([{ op: 'contextFeedback', contextId: 'lost-gl' }], true).contexts['lost-gl'].errors).toBeUndefined()
		gl.restore()
		node.canvas.dispatchEvent(new Event('webglcontextrestored'))
		expect(send.mock.calls.at(-1)[0].body.contexts['lost-gl'].contextLost).toBe(false)
		expect(flush([{ op: 'contextQuery', contextId: 'lost-gl', method: 'isContextLost', args: [], key: 'lost' }], true).contexts['lost-gl'].queries[0].value).toBe(false)
	})
})
