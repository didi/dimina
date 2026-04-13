import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
