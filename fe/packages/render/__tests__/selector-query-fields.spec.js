import { WxmlTree } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime'
import message from '../src/core/message'

describe('SelectorQuery field and batching contracts', () => {
	const bridgeId = 'selector-fields'
	let element, node, tree
	beforeEach(() => {
		element = document.createElement('div')
		element.style.color = 'red'
		element.getBoundingClientRect = () => ({ left: 1.5, top: 2, right: 4.25, bottom: 6.75, width: 2.75, height: 4.75 })
		node = { nodeId: 'target', parentId: 's:page', scopeId: 'page', id: 'target', class: 'node',
			dataset: { object: { value: 1 } }, marks: { nearest: 'target' }, properties: { scrollX: true, value: 7 }, roots: [element] }
		tree = new WxmlTree([{ nodeId: 's:page', scopeId: 'page', shadow: true, marks: { outer: 'page' } }, node])
		runtime.wxmlSnapshots.set(bridgeId, { tree })
		vi.spyOn(message, 'send').mockImplementation(() => {})
	})
	afterEach(() => { runtime.wxmlSnapshots.delete(bridgeId); vi.restoreAllMocks() })

	it('keeps absent results at their request index and measures valid zero-sized nodes without polling', async () => {
		await runtime.selectorQuery({ bridgeId, params: { success: 'callback', tasks: [
			{ moduleId: 'page', selector: '#missing', single: true, fields: { rect: true } },
			{ moduleId: 'page', selector: '.node', single: true, fields: { id: true } },
			{ moduleId: 'page', selector: '.missing', single: false, fields: {} },
		] } })
		expect(message.send).toHaveBeenLastCalledWith(expect.objectContaining({ body: {
			bridgeId, id: 'callback', args: [null, { id: 'target' }, []],
		} }))
	})
	it('returns fractional border-box geometry and respects separate rect and size flags', async () => {
		expect(await runtime.parseElement(element, { rect: true }, bridgeId, node, tree))
			.toEqual({ left: 1.5, top: 2, right: 4.25, bottom: 6.75 })
		expect(await runtime.parseElement(element, { size: true }, bridgeId, node, tree))
			.toEqual({ width: 2.75, height: 4.75 })
	})
	it('returns public properties and computed styles at the top level and preserves typed dataset and marks', async () => {
		const result = await runtime.parseElement(element, {
			dataset: true, mark: true, properties: ['scroll-x', 'value', 'id', 'class', 'style', 'bindtap', 'missing'], computedStyle: ['color'],
		}, bridgeId, node, tree)
		expect(result).toEqual({
			dataset: { object: { value: 1 } }, mark: { nearest: 'target', outer: 'page' },
			scrollX: true, value: 7, color: 'rgb(255, 0, 0)',
		})
	})
	it('measures a fragment component as the union of its committed root rectangles', async () => {
		const other = document.createElement('div')
		other.getBoundingClientRect = () => ({ left: 0, top: 10, right: 12, bottom: 15, width: 12, height: 5 })
		node.roots.push(other)
		expect(await runtime.parseElement(element, { rect: true, size: true }, bridgeId, node, tree))
			.toEqual({ left: 0, top: 2, right: 12, bottom: 15, width: 12, height: 13 })
	})
	it('returns the viewport shape used by the bundled webview implementation', () => {
		expect(runtime.parseViewport({ id: true, dataset: true, mark: true, rect: true }))
			.toEqual({ id: '', dataset: {}, mark: {}, left: 0, right: 0, top: 0, bottom: 0 })
	})
	it('describes supported contexts in the selected node scope and omits context on ordinary nodes', async () => {
		expect(await runtime.parseElement(element, { context: true }, bridgeId, node, tree)).toEqual({})
		expect(await runtime.parseElement(element, { node: true }, bridgeId, node, tree)).toEqual({})
		for (const tag of ['video', 'map', 'canvas']) {
			node.tag = tag
			node.properties.canvasId = 'drawing'
			expect(await runtime.parseElement(element, { context: true }, bridgeId, node, tree)).toEqual({
				context: { __diminaSelectorContext: true, type: tag, id: tag === 'canvas' ? 'drawing' : 'target', moduleId: 'page' },
			})
		}
	})
})
