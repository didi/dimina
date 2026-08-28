/** @vitest-environment jsdom */

// 自定义组件的宿主节点和普通组件必须共用同一条手势链路。宿主靠原生 click 派发 tap 时，
// 祖先的合成 tap 已经在 touchend 的微任务里发出去了，宿主上的 catchtap 再也拦不住它，
// 组件内部的 catchtap 同样切不断宿主自己的 bindtap。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide } from 'vue'
import ComponentHost from '../src/component/component-host/ComponentHost.vue'
import View from '../src/component/view/View.vue'

const PAGE_PATH = '/pages/index/index'
const CHILD_PATH = '/components/child/index'
const mounts = []

function touchPoint({ clientX = 10, clientY = 10, identifier = 0 } = {}) {
	return {
		clientX,
		clientY,
		force: 1,
		identifier,
		pageX: clientX,
		pageY: clientY,
		screenX: clientX,
		screenY: clientY,
	}
}

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function fireTouch(target, type, points = []) {
	return fire(target, type, { changedTouches: points, targetTouches: points, touches: points })
}

// 复刻渲染层给自定义组件建立的作用域：宿主节点写在父级模板里，它的 bind/catch 归声明这次使用的
// 页面（pageId）处理；组件模板内部的节点归组件自己的 moduleId 处理。
function createChild(innerSlot) {
	return {
		setup() {
			provide('path', CHILD_PATH)
			provide(CHILD_PATH, { id: 'module-child', pageId: 'page-1', pagePath: PAGE_PATH })
			// 父级写在 <child> 上的 bind/catch 以 fallthrough attrs 落到唯一根节点，也就是宿主节点。
			return () => h(ComponentHost, { name: CHILD_PATH }, { default: innerSlot })
		},
	}
}

function mountTree({ hostAttrs, inner = () => [h('span', { class: 'leaf' })] }) {
	const container = document.createElement('div')
	document.body.append(container)
	const Child = createChild(inner)
	const app = createApp({
		setup() {
			provide('bridgeId', 'bridge-1')
			provide('path', PAGE_PATH)
			provide(PAGE_PATH, { id: 'page-1' })
			return () => h(View, { bindtap: 'outer' }, { default: () => [h(Child, hostAttrs)] })
		},
	})
	app.mount(container)
	mounts.push({ app, container })
	return container
}

// 每条 tap 记成 `moduleId:methodName`，同时锁住宿主节点派发到声明它的模块。
function tapCalls() {
	return window.__message.send.mock.calls
		.map(([message]) => message.body)
		.filter(body => body.event?.type === 'tap')
		.map(body => `${body.moduleId}:${body.methodName}`)
}

beforeEach(() => {
	window.__message = { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), send: vi.fn() }
	window.__callback = { remove: vi.fn(), store: vi.fn(() => 'callback-1') }
})

afterEach(() => {
	while (mounts.length) {
		const { app, container } = mounts.pop()
		app.unmount()
		container.remove()
	}
})

describe('custom component host joins the synthesized tap chain', () => {
	it('lets catchtap on the host stop the ancestor bindtap for touch input', async () => {
		const container = mountTree({ hostAttrs: { catchtap: 'inner' } })
		const leaf = container.querySelector('.leaf')

		fireTouch(leaf, 'touchstart', [touchPoint()])
		fireTouch(leaf, 'touchend', [touchPoint()])
		await nextTick()

		expect(tapCalls()).toEqual(['page-1:inner'])
	})

	it('lets catchtap on the host stop the ancestor bindtap for pointer input', async () => {
		const container = mountTree({ hostAttrs: { catchtap: 'inner' } })
		const leaf = container.querySelector('.leaf')

		fire(leaf, 'pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse' })
		fire(document, 'pointerup', { button: 0, clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse' })
		await nextTick()

		expect(tapCalls()).toEqual(['page-1:inner'])
	})

	it('still bubbles bindtap on the host to the ancestor, host first', async () => {
		const container = mountTree({ hostAttrs: { bindtap: 'inner' } })
		const leaf = container.querySelector('.leaf')

		fireTouch(leaf, 'touchstart', [touchPoint()])
		fireTouch(leaf, 'touchend', [touchPoint()])
		await nextTick()

		expect(tapCalls()).toEqual(['page-1:inner', 'page-1:outer'])
	})

	it('lets a catchtap inside the component stop the host and the ancestor', async () => {
		const container = mountTree({
			hostAttrs: { bindtap: 'inner' },
			inner: () => [h(View, { catchtap: 'childInner' }, { default: () => [h('span', { class: 'leaf' })] })],
		})
		const leaf = container.querySelector('.leaf')

		fireTouch(leaf, 'touchstart', [touchPoint()])
		fireTouch(leaf, 'touchend', [touchPoint()])
		await nextTick()

		expect(tapCalls()).toEqual(['module-child:childInner'])
	})

	it('keeps programmatic clicks activating the host', async () => {
		const container = mountTree({ hostAttrs: { catchtap: 'inner' } })

		container.querySelector('.leaf').click()
		await nextTick()

		expect(tapCalls()).toEqual(['page-1:inner'])
	})
})
