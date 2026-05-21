import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { createApp, h, nextTick } from 'vue'

const groupA = [
	{ id: 1, name: 'Alice', score: 90 },
	{ id: 2, name: 'Bob', score: 85 },
	{ id: 3, name: 'Charlie', score: 78 },
]

const groupB = [
	{ id: 1, name: 'Dave', score: 92 },
	{ id: 2, name: 'Eve', score: 88 },
	{ id: 3, name: 'Frank', score: 71 },
]

describe('runtime template components', () => {
	let dom
	let runtime

	beforeEach(async () => {
		dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
		globalThis.window = dom.window
		globalThis.document = dom.window.document
		globalThis.Node = dom.window.Node
		globalThis.Element = dom.window.Element
		globalThis.HTMLElement = dom.window.HTMLElement
		globalThis.SVGElement = dom.window.SVGElement
		globalThis.MutationObserver = dom.window.MutationObserver
		globalThis.navigator = dom.window.navigator
		globalThis.requestAnimationFrame = dom.window.requestAnimationFrame ?? (cb => setTimeout(cb, 0))
		globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame ?? (id => clearTimeout(id))

		runtime = (await import('../src/core/runtime.js')).default
	})

	afterEach(() => {
		dom.window.close()
		delete globalThis.window
		delete globalThis.document
		delete globalThis.Node
		delete globalThis.Element
		delete globalThis.HTMLElement
		delete globalThis.SVGElement
		delete globalThis.MutationObserver
		delete globalThis.navigator
		delete globalThis.requestAnimationFrame
		delete globalThis.cancelAnimationFrame
	})

	it('syncs template data when keyed list items are replaced', async () => {
		const TplItem = runtime.createTplComponent({
			id: 'tpl-item',
			render() {
				return h('div', { class: 'item' }, [
					h('span', { class: 'item-name' }, this.name),
					h('span', { class: 'item-score' }, `Score: ${this.score}`),
				])
			},
		})

		const state = { list: groupA }
		const app = createApp({
			data: () => state,
			render() {
				return h(
					'div',
					{ class: 'list' },
					this.list.map(item => h(TplItem, { key: item.id, data: item })),
				)
			},
		})

		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)

		expect(root.textContent).toContain('Alice')
		expect(root.textContent).toContain('Charlie')

		state.list = groupB
		app._instance.update()
		await nextTick()

		expect(root.textContent).toContain('Dave')
		expect(root.textContent).toContain('Eve')
		expect(root.textContent).toContain('Frank')
		expect(root.textContent).not.toContain('Alice')
		expect(root.textContent).not.toContain('Charlie')

		app.unmount()
	})

	it('treats missing template data fields as undefined', async () => {
		const warnings = []
		const TplHead = runtime.createTplComponent({
			id: 'tpl-head',
			render() {
				return h('div', [
					h('span', { class: 'head-title' }, this.title),
					this.desc ? h('span', { class: 'head-desc' }, this.desc) : null,
				])
			},
		})

		const app = createApp({
			render() {
				return h(TplHead, { data: { title: 'swiper' } })
			},
		})
		app.config.warnHandler = (message) => {
			warnings.push(message)
		}

		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		await nextTick()

		expect(root.textContent).toBe('swiper')
		expect(warnings).toEqual([])

		app.unmount()
	})

	it('returns a serializable canvas node from selector node fields', async () => {
		runtime.ensureElementReady = async element => element
		runtime.canvasNodes.clear()

		const canvas = document.createElement('canvas')
		canvas.setAttribute('type', 'webgl')
		canvas.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			right: 300,
			bottom: 300,
			width: 300,
			height: 300,
		}))
		document.body.append(canvas)

		const result = await runtime.parseElement(canvas, {
			node: true,
			size: true,
		})

		expect(result.node.__diminaNodeType).toBe('dimina-canvas-node')
		expect(result.node.type).toBe('webgl')
		expect(result.node.width).toBe(300)
		expect(result.node.height).toBe(300)
		expect(canvas.width).toBe(300)
		expect(canvas.height).toBe(300)
		expect(runtime.canvasNodes.has(result.node.nodeId)).toBe(true)

		canvas.width = 600
		canvas.height = 600
		const nextResult = await runtime.parseElement(canvas, {
			node: true,
		})
		expect(nextResult.node.width).toBe(600)
		expect(nextResult.node.height).toBe(600)
		expect(canvas.width).toBe(600)
		expect(canvas.height).toBe(600)
	})

	it('replays canvas node webgl operations against the real context', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()

		const shader = { kind: 'shader' }
		const gl = {
			VERTEX_SHADER: 0x8B31,
			createShader: vi.fn(() => shader),
			shaderSource: vi.fn(),
			compileShader: vi.fn(),
			viewport: vi.fn(),
		}
		const canvas = document.createElement('canvas')
		canvas.getContext = vi.fn(() => gl)
		runtime.canvasNodes.set('canvas_1', {
			canvas,
			contexts: new Map(),
		})

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_1',
			params: {
				nodeId: 'canvas_1',
				operations: [
					{ op: 'setCanvasProperty', prop: 'width', value: 600 },
					{ op: 'getContext', contextId: 'ctx_1', contextType: 'webgl' },
					{ op: 'contextCall', contextId: 'ctx_1', method: 'viewport', args: [0, 0, 300, 150] },
					{ op: 'contextCall', contextId: 'ctx_1', method: 'createShader', args: [0x8B31], resultId: 'shader_1' },
					{
						op: 'contextCall',
						contextId: 'ctx_1',
						method: 'shaderSource',
						args: [{ __canvasResourceId: 'shader_1' }, 'void main() {}'],
					},
					{
						op: 'contextCall',
						contextId: 'ctx_1',
						method: 'compileShader',
						args: [{ __canvasResourceId: 'shader_1' }],
					},
				],
			},
		})

		expect(canvas.width).toBe(600)
		expect(canvas.getContext).toHaveBeenCalledWith('webgl', undefined)
		expect(gl.viewport).toHaveBeenCalledWith(0, 0, 300, 150)
		expect(gl.shaderSource).toHaveBeenCalledWith(shader, 'void main() {}')
		expect(gl.compileShader).toHaveBeenCalledWith(shader)
	})
})
