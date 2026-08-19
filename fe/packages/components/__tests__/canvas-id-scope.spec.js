/** @vitest-environment jsdom */

// canvas-id 判重的作用域是宿主组件实例，和渲染层 getCanvasElement(canvasId, moduleId) 保持一致：
// 同一个自定义组件被用两次时，两个实例各自的同名 canvas-id 都必须能用。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide } from 'vue'
import Canvas from '../src/component/canvas/Canvas.vue'

const mounts = []

// 模拟一个自定义组件实例：它给自己的子树注入独立的 path 与 info.id，useInfo() 由此拿到 moduleId。
function mountHost({ moduleId, canvasId, bridgeId = 'bridge-1' }) {
	const host = document.createElement('div')
	document.body.append(host)
	const app = createApp({
		setup() {
			provide('bridgeId', bridgeId)
			provide('path', `path-${moduleId}`)
			provide(`path-${moduleId}`, { id: moduleId })
			return () => h(Canvas, { binderror: 'onCanvasError', canvasId })
		},
	})
	app.mount(host)
	const mounted = { app, host }
	mounts.push(mounted)
	return mounted
}

function isHidden({ host }) {
	return host.querySelector('.dd-canvas').style.display === 'none'
}

function errorMessages() {
	return window.__message.send.mock.calls
		.map(([message]) => message.body)
		.filter(body => body.methodName === 'onCanvasError')
		.map(body => body.event.detail.errMsg)
}

beforeEach(() => {
	window.__message = { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), send: vi.fn() }
	window.__callback = { remove: vi.fn(), store: vi.fn(() => 'callback-1') }
})

afterEach(() => {
	while (mounts.length) {
		const { app, host } = mounts.pop()
		app.unmount()
		host.remove()
	}
})

describe('canvas-id duplicate detection is scoped to the owning component instance', () => {
	it('lets two instances of the same component each keep their own copy of one canvas-id', async () => {
		const first = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		const second = mountHost({ canvasId: 'chart', moduleId: 'module-b' })
		await nextTick()

		expect(isHidden(first)).toBe(false)
		expect(isHidden(second)).toBe(false)
		expect(errorMessages()).toEqual([])
	})

	it('still rejects the second canvas when both live in the same instance, and keeps the first one usable', async () => {
		const first = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		const second = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()

		expect(isHidden(first)).toBe(false)
		expect(isHidden(second)).toBe(true)
		expect(errorMessages()).toEqual(['canvas-id chart in this page has already existed'])
	})

	it('separates instances that share a moduleId across different pages', async () => {
		const first = mountHost({ bridgeId: 'bridge-1', canvasId: 'chart', moduleId: 'module-a' })
		const second = mountHost({ bridgeId: 'bridge-2', canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()

		expect(isHidden(first)).toBe(false)
		expect(isHidden(second)).toBe(false)
		expect(errorMessages()).toEqual([])
	})

	// 被判重拒绝的实例从未登记，它卸载时不能把先到者的 key 一起归还。
	it('frees the id when the winner unmounts, and does not free it when a rejected duplicate unmounts', async () => {
		mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		const rejected = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()

		rejected.app.unmount()
		const afterRejectedLeft = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()
		expect(isHidden(afterRejectedLeft)).toBe(true)

		const winner = mounts[0]
		winner.app.unmount()
		const afterWinnerLeft = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()
		expect(isHidden(afterWinnerLeft)).toBe(false)
	})
})
