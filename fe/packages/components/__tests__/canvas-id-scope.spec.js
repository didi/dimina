/** @vitest-environment jsdom */

// canvas-id 判重的作用域是宿主组件实例，和渲染层 getCanvasElement(canvasId, moduleId) 保持一致：
// 同一个自定义组件被用两次时，两个实例各自的同名 canvas-id 都必须能用。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, ref } from 'vue'
import Canvas from '../src/component/canvas/Canvas.vue'

const mounts = []

// 模拟一个自定义组件实例：它给自己的子树注入独立的 path 与 info.id，useInfo() 由此拿到 moduleId。
function mountHost({ moduleId, canvasId, bridgeId = 'bridge-1' }) {
	const host = document.createElement('div')
	document.body.append(host)
	const canvasIdRef = ref(canvasId)
	const app = createApp({
		setup() {
			provide('bridgeId', bridgeId)
			provide('path', `path-${moduleId}`)
			provide(`path-${moduleId}`, { id: moduleId })
			return () => h(Canvas, { binderror: 'onCanvasError', canvasId: canvasIdRef.value })
		},
	})
	app.mount(host)
	const mounted = {
		app,
		host,
		async setCanvasId(next) {
			canvasIdRef.value = next
			await nextTick()
		},
	}
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

	// 被判重拒绝的实例从未登记，它卸载时不能把先到者的 key 一起归还；而先到者让出时，
	// 这个 id 归还给仍然挂着的那个被拒实例——它被拒的理由已经不成立了。
	it('hands a freed id to a still-mounted rejected duplicate, and a rejected duplicate leaving frees nothing', async () => {
		mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		const rejected = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()

		rejected.app.unmount()
		const stillRejected = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()
		expect(isHidden(stillRejected)).toBe(true)

		const winner = mounts[0]
		winner.app.unmount()
		await nextTick()
		expect(isHidden(stillRejected)).toBe(false)

		const latecomer = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()
		expect(isHidden(latecomer)).toBe(true)
	})
})

// canvas-id 绑的是数据，改它和改别的属性一样合法，模板上的 canvas-id 也确实会跟着变。
describe('canvas-id duplicate detection follows a canvas-id that changes', () => {
	it('gives up the old id so another canvas can take it', async () => {
		const moving = mountHost({ canvasId: 'before', moduleId: 'module-a' })
		await nextTick()
		await moving.setCanvasId('after')

		const taker = mountHost({ canvasId: 'before', moduleId: 'module-a' })
		await nextTick()

		expect(isHidden(taker)).toBe(false)
		expect(errorMessages()).toEqual([])
	})

	it('holds the new id so a later duplicate of it is rejected', async () => {
		const moving = mountHost({ canvasId: 'before', moduleId: 'module-a' })
		await nextTick()
		await moving.setCanvasId('after')

		const duplicate = mountHost({ canvasId: 'after', moduleId: 'module-a' })
		await nextTick()

		expect(isHidden(moving)).toBe(false)
		expect(isHidden(duplicate)).toBe(true)
		expect(errorMessages()).toEqual(['canvas-id after in this page has already existed'])
	})

	it('hides a canvas that moves onto a taken id, and shows it again when it moves off', async () => {
		const holder = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		const moving = mountHost({ canvasId: 'other', moduleId: 'module-a' })
		await nextTick()

		await moving.setCanvasId('chart')
		expect(isHidden(moving)).toBe(true)
		expect(isHidden(holder)).toBe(false)
		expect(errorMessages()).toEqual(['canvas-id chart in this page has already existed'])

		await moving.setCanvasId('other')
		expect(isHidden(moving)).toBe(false)
	})

	it('reports the empty id as undefined rather than silently keeping the old registration', async () => {
		const moving = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()

		await moving.setCanvasId('')
		expect(isHidden(moving)).toBe(true)
		expect(errorMessages()).toEqual(['canvas-id attribute is undefined'])

		const taker = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
		await nextTick()
		expect(isHidden(taker)).toBe(false)
	})
})

// 同一次更新里让出与接手同时发生：canvas-id 的 watch 是 pre-flush、onUnmounted 是 post-flush，
// 接手方先跑，看到的表还没被让出。这一组用例锁住「接手能成」而不是「谁先声明谁赢」。
function mountPage(render, { bridgeId = 'bridge-1', moduleId = 'page' } = {}) {
	const host = document.createElement('div')
	document.body.append(host)
	const app = createApp({
		setup() {
			provide('bridgeId', bridgeId)
			provide('path', `path-${moduleId}`)
			provide(`path-${moduleId}`, { id: moduleId })
			return render
		},
	})
	app.mount(host)
	const mounted = { app, host }
	mounts.push(mounted)
	return mounted
}

function hiddenStates({ host }) {
	return [...host.querySelectorAll('.dd-canvas')].map(el => el.style.display === 'none')
}

// 渲染层按 data-canvas-owner 精确命中归属，判重 key 用的是同一个 moduleId。
// 两边分开测都会绿，所以这里把属性名和取值钉在一起。
it('canvas 元素带上与判重 key 同源的归属标记', async () => {
	const { host } = mountHost({ canvasId: 'chart', moduleId: 'module-a' })
	await nextTick()

	expect(host.querySelector('canvas').dataset.canvasOwner).toBe('module-a')
})

describe('同一 tick 内的让出与接手', () => {
	it('接手另一个实例在同一次更新里卸载让出的 canvas-id', async () => {
		const showA = ref(true)
		const bId = ref('other')
		const page = mountPage(() => h('div', [
			showA.value ? h(Canvas, { key: 'A', binderror: 'onCanvasError', canvasId: 'chart' }) : null,
			h(Canvas, { key: 'B', binderror: 'onCanvasError', canvasId: bId.value }),
		]))
		await nextTick()
		expect(hiddenStates(page)).toEqual([false, false])

		showA.value = false
		bId.value = 'chart'
		await nextTick()
		await nextTick()

		expect(hiddenStates(page)).toEqual([false])
		expect(errorMessages()).toEqual([])
	})

	it('两个实例在同一次更新里交换 canvas-id', async () => {
		const first = ref('chart')
		const second = ref('other')
		const page = mountPage(() => h('div', [
			h(Canvas, { key: 'A', binderror: 'onCanvasError', canvasId: first.value }),
			h(Canvas, { key: 'B', binderror: 'onCanvasError', canvasId: second.value }),
		]))
		await nextTick()

		first.value = 'other'
		second.value = 'chart'
		await nextTick()
		await nextTick()

		expect(hiddenStates(page)).toEqual([false, false])
		expect(errorMessages()).toEqual([])
	})

	it('真正的重复仍然报错并隐藏后来者', async () => {
		const bId = ref('other')
		const page = mountPage(() => h('div', [
			h(Canvas, { key: 'A', binderror: 'onCanvasError', canvasId: 'chart' }),
			h(Canvas, { key: 'B', binderror: 'onCanvasError', canvasId: bId.value }),
		]))
		await nextTick()

		bId.value = 'chart'
		await nextTick()
		await nextTick()

		expect(hiddenStates(page)).toEqual([false, true])
		expect(errorMessages()).toEqual(['canvas-id chart in this page has already existed'])
	})
})
