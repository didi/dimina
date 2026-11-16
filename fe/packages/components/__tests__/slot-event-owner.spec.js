/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, ref, renderSlot, withCtx } from 'vue'
import CoverView from '../src/component/cover-view/CoverView.vue'
import View from '../src/component/view/View.vue'
import * as events from '../src/common/events.js'

let app
beforeEach(() => {
	window.__message = { send: vi.fn() }
})
afterEach(() => {
	app?.unmount()
	document.body.innerHTML = ''
	vi.restoreAllMocks()
})

function context(path, id, pagePath) {
	provide('path', path)
	provide(path, { id, pagePath })
}

const Animation = defineComponent({
	__scopeId: 'data-v-animation',
	setup() {
		context('/animation', 'animation-instance', '/popup')
	},
	render() {
		return h(View, { id: 'animation', bindtap: 'maskTap' }, {
			default: withCtx(() => [renderSlot(this.$slots, 'default')]),
		})
	},
})

// 透传层可以提供主题等无关依赖，但不应因此成为小程序事件的声明者。
const ThemedForwarder = defineComponent({
	setup() {
		provide('theme', 'dark')
	},
	render() {
		return h(CoverView, this.$attrs, {
			default: withCtx(() => [renderSlot(this.$slots, 'default')]),
		})
	},
})

async function tap(element) {
	const point = { identifier: 1, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
	for (const type of ['touchstart', 'touchend']) {
		const event = new Event(type, { bubbles: true, cancelable: true })
		Object.assign(event, { touches: type === 'touchstart' ? [point] : [], changedTouches: [point] })
		element.dispatchEvent(event)
	}
	await Promise.resolve()
	await nextTick()
}

function mountPopup(wrap) {
	const visible = ref(true)
	const Popup = defineComponent({
		__scopeId: 'data-v-popup',
		setup() {
			context('/popup', 'popup-instance', '/page')
		},
		render() {
			return visible.value ? h(Animation, null, {
				default: withCtx(() => [wrap(withCtx(() => [h(View, { id: 'close', bindtap: 'closePopup' }, {
					default: withCtx(() => [h(View, { id: 'icon' }, () => '×')]),
				})]))]),
			}) : null
		},
	})
	app = createApp({
		setup() {
			provide('bridgeId', 'bridge')
			context('/page', 'page-instance')
			return () => h(Popup)
		},
	})
	const host = document.createElement('div')
	document.body.append(host)
	app.mount(host)
	return { host, visible }
}

describe('event ownership through slots', () => {
	it('resolves forwarding event owners without Object.hasOwn on WebView 83', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(Object, 'hasOwn')
		const originalUseInfo = events.useInfo
		// jsdom 31 本身依赖 Object.hasOwn；仅在框架解析事件归属时模拟旧 WebView，
		// 避免破坏 DOM 测试环境，同时保留真实组件挂载和事件派发。
		const useInfo = vi.spyOn(events, 'useInfo').mockImplementation((...args) => {
			try {
				Object.defineProperty(Object, 'hasOwn', { value: undefined, configurable: true })
				return originalUseInfo(...args)
			}
			finally {
				Object.defineProperty(Object, 'hasOwn', descriptor)
			}
		})
		const { host } = mountPopup(content => h(ThemedForwarder, null, { default: content }))
		expect(useInfo).toHaveBeenCalled()
		expect(host.querySelector('#icon')?.textContent).toBe('×')
		await tap(host.querySelector('#icon'))
		expect(window.__message.send).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({ moduleId: 'popup-instance', methodName: 'closePopup' }),
		}))
	})

	it.each([
		['direct slot', content => content()[0]],
		['view wrapper', content => h(View, null, { default: content })],
		['cover-view wrapper', content => h(CoverView, null, { default: content })],
		['nested cover-view and view wrappers', content => h(CoverView, null, {
			default: withCtx(() => [h(View, { catchtap: 'contentTap' }, { default: content })]),
		})],
	])('dispatches a close icon to its declaring popup through a %s', async (_, wrap) => {
		const { host, visible } = mountPopup(wrap)
		window.__message.send.mockImplementation(({ body }) => {
			if (body.moduleId === 'popup-instance' && body.methodName === 'closePopup') visible.value = false
		})
		await tap(host.querySelector('#icon'))
		const close = window.__message.send.mock.calls.map(([message]) => message.body)
			.filter(body => body.methodName === 'closePopup')
		expect(close).toHaveLength(1)
		expect(close[0]).toMatchObject({ bridgeId: 'bridge', moduleId: 'popup-instance' })
		expect(host.querySelector('#close')).toBeNull()
	})

	it('keeps bindings on a forwarding cover-view in the declaring popup scope', async () => {
		const { host } = mountPopup(content => h(CoverView, { id: 'cover', catchtap: 'backgroundTap' }, { default: content }))
		await tap(host.querySelector('#cover'))
		expect(window.__message.send).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({ moduleId: 'popup-instance', methodName: 'backgroundTap' }),
		}))
	})

	it('ignores unrelated dependency providers in forwarding components', async () => {
		const { host } = mountPopup(content => h(ThemedForwarder, { id: 'themed', catchtap: 'backgroundTap' }, { default: content }))
		await tap(host.querySelector('#themed'))
		expect(window.__message.send).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({ moduleId: 'popup-instance', methodName: 'backgroundTap' }),
		}))
	})

	it('keeps the receiving component own nodes in its own event scope', async () => {
		const { host } = mountPopup(content => h(CoverView, null, { default: content }))
		await tap(host.querySelector('#animation'))
		expect(window.__message.send).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({ moduleId: 'animation-instance', methodName: 'maskTap' }),
		}))
	})
})
