/** @vitest-environment jsdom */
// 事件载荷里的 dataset 是开发者在 WXML 上声明的 data-* 的镜像。框架为自己记的东西一旦
// 落在 data-* 上就会被整份复制进去，小程序会收到它从没声明过的字段，并且拿到框架内部的
// 组件实例 id。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, provide } from 'vue'
import Canvas from '../src/component/canvas/Canvas.vue'

const PATH = '/pages/index/index'

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function touchPoint({ identifier = 0, pageX = 10, pageY = 10 } = {}) {
	return { identifier, pageX, pageY, clientX: pageX, clientY: pageY, screenX: pageX, screenY: pageY, force: 1 }
}

function mount(render) {
	const container = document.createElement('div')
	document.body.append(container)
	const app = createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', PATH)
			provide(PATH, { id: 'module-1' })
			return render
		},
	})
	app.mount(container)
	return container
}

async function flush() {
	await Promise.resolve()
	await Promise.resolve()
}

function sentEvents(methodName) {
	return window.__message.send.mock.calls
		.map(([m]) => m.body)
		.filter(body => body.methodName === methodName)
		.map(body => body.event)
}

beforeEach(() => {
	window.__message = { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), send: vi.fn() }
	window.__callback = { remove: vi.fn(), store: vi.fn(() => 'callback-1') }
	document.body.innerHTML = ''
})

describe('canvas 事件载荷', () => {
	it('不把框架内部的归属标记交给小程序', async () => {
		const container = mount(() => h(Canvas, {
			bindtouchstart: 'onTouchStart',
			canvasId: 'chart',
			'data-role': 'chart-surface',
		}))
		await flush()

		fire(container.querySelector('canvas'), 'touchstart', {
			changedTouches: [touchPoint()],
			targetTouches: [touchPoint()],
			touches: [touchPoint()],
		})
		await flush()

		const events = sentEvents('onTouchStart')
		expect(events).toHaveLength(1)
		// 开发者声明的 data-* 照常送达，框架自己的记号一个都不能出现。
		expect(events[0].target.dataset).toEqual({ role: 'chart-surface' })
	})

	// 小程序写的 canvas 是根节点这一个节点，border 按 CSS 属于它；内层 canvas 绝对定位在 border 内侧，拿它当基准会让带 border 的画布上每个触摸点都偏移一个 border 宽度。
	it('相对坐标以根节点为基准，不受内层画布的 border 内缩影响', async () => {
		const container = mount(() => h(Canvas, {
			bindtouchstart: 'onTouchStart',
			canvasId: 'chart',
		}))
		await flush()

		const root = container.querySelector('.dd-canvas')
		const inner = container.querySelector('canvas')
		root.getBoundingClientRect = () => ({ bottom: 288, height: 268, left: 10, right: 338, top: 20, width: 328 })
		// 4px border：内层画布的左上角比根节点缩进一个 border 宽度。
		inner.getBoundingClientRect = () => ({ bottom: 284, height: 260, left: 14, right: 334, top: 24, width: 320 })

		fire(inner, 'touchstart', {
			changedTouches: [touchPoint({ pageX: 50, pageY: 60 })],
			targetTouches: [touchPoint({ pageX: 50, pageY: 60 })],
			touches: [touchPoint({ pageX: 50, pageY: 60 })],
		})
		await flush()

		const events = sentEvents('onTouchStart')
		expect(events).toHaveLength(1)
		expect(events[0].touches[0]).toMatchObject({ x: 40, y: 40 })
	})

	// tap 是框架在 touchend 之后合成的，走的是另一条派发分支，载荷得单独验一次。
	it('合成 tap 的载荷同样只带开发者声明的 data-*', async () => {
		const container = mount(() => h(Canvas, {
			bindtap: 'onTap',
			canvasId: 'chart',
			'data-role': 'chart-surface',
		}))
		await flush()

		const inner = container.querySelector('canvas')
		fire(inner, 'touchstart', {
			changedTouches: [touchPoint()],
			targetTouches: [touchPoint()],
			touches: [touchPoint()],
		})
		fire(inner, 'touchend', {
			changedTouches: [touchPoint()],
			targetTouches: [],
			touches: [],
		})
		await flush()

		const events = sentEvents('onTap')
		expect(events).toHaveLength(1)
		expect(events[0].target.dataset).toEqual({ role: 'chart-surface' })
	})
})
