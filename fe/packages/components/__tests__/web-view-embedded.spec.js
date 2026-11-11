/** @vitest-environment jsdom */
import { createApp, h, nextTick, provide, reactive } from 'vue'
import WebView from '../src/component/web-view/WebView.vue'

const platform = vi.hoisted(() => ({ isAndroid: true, isDesktop: false, isHarmonyOS: false }))
vi.mock('@dimina/common', () => platform)
vi.mock('../src/common/nativeLayerTouchBridge', () => ({ ensureNativeLayerTouchBridge: vi.fn() }))
const mounts = []
const channel = 'dimina:web-view:v1'

function mount(values = {}) {
	const props = reactive({ id: 'card', src: 'https://card.example/form', embedded: true, ...values })
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', 'page')
			provide('page', { id: 'module-1' })
			return () => h(WebView, { ...props, bindmessage: 'receive', bindload: 'loaded', binderror: 'failed' })
		},
	})
	app.mount(host)
	mounts.push({ app, host })
	return { props, host, app, frame: () => host.querySelector('iframe') }
}

function message(source, data) {
	window.dispatchEvent(new MessageEvent('message', { source, data, origin: 'https://card.example' }))
}

function request(frame, name, params = {}, type = 'h5SdkAction') {
	message(frame.contentWindow, {
		channel, kind: 'invoke', session: 'guest-1',
		request: { type, body: { name, params: { data: { params }, success: 'callback-1' } } },
	})
}

beforeEach(() => {
	platform.isDesktop = false
	platform.isHarmonyOS = false
	window.__message = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() }
})
afterEach(() => {
	for (const { app, host } of mounts.splice(0)) { app.unmount(); host.remove() }
	delete window.__message
	delete window.DiminaRenderBridge
})

it.each([
	['Android', true, false], ['iOS', false, false], ['Harmony', false, false], ['Web', false, true],
])('renders an inline frame in %s without mounting a native view', (_, android, desktop) => {
	platform.isAndroid = android
	platform.isDesktop = desktop
	const { frame, host } = mount({ style: 'height: 200px; width: 80%; border-radius: 12px' })
	expect(frame()).not.toBeNull()
	expect(host.querySelector('embed')).toBeNull()
	expect(frame().classList.contains('dd-web-view-embedded')).toBe(true)
	expect(frame().classList.contains('dd-web-view-pc')).toBe(false)
	expect(frame().style.height).toBe('200px')
	expect(window.__message.invoke).not.toHaveBeenCalled()
})

it('routes SDK and raw messages only from the current instance', () => {
	const a = mount(), b = mount({ id: 'other' })
	message(window, { forged: true })
	expect(window.__message.send).not.toHaveBeenCalled()
	request(a.frame(), 'h5postMessage', { data: { value: 1 } })
	expect(window.__message.send).toHaveBeenCalledTimes(1)
	expect(window.__message.send.mock.calls[0][0].body.event.detail).toEqual({ data: [{ value: 1 }] })
	expect(window.__message.send.mock.calls[0][0].body.event.currentTarget.id).toBe('card')
	expect(window.__message.send.mock.calls[0][0].body.event.target.id).toBe('card')
	message(b.frame().contentWindow, 'raw')
	expect(window.__message.send.mock.calls[1][0].body.event.detail).toEqual({ data: ['raw'] })
})

it('answers getEnv, ignores malformed requests and rejects arbitrary native APIs', () => {
	const { frame } = mount()
	const reply = vi.spyOn(frame().contentWindow, 'postMessage')
	request(frame(), 'getEnv', {}, 'invokeAPI')
	expect(reply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'callback', session: 'guest-1', id: 'callback-1', args: { data: { miniprogram: true } } }), 'https://card.example')
	message(frame().contentWindow, { channel, kind: 'invoke', request: null })
	request(frame(), 'setStorage', { key: 'secret' }, 'invokeAPI')
	expect(window.__message.invoke).not.toHaveBeenCalled()
	expect(reply.mock.calls.at(-1)[0].args.data.success).toBe(false)
})

it('uses the owning service route without forwarding guest bridge or callback metadata', () => {
	const { frame } = mount()
	message(frame().contentWindow, {
		channel, kind: 'invoke', session: 'route',
		request: { type: 'h5SdkAction', body: {
			name: 'H5navigateTo', bridgeId: 'forged', moduleId: 'forged', attrs: { message: 'forged' },
			params: { success: 'forged', data: { params: { url: './next', bridgeId: 'forged', success: 'forged' } } },
		} },
	})
	expect(window.__message.send).toHaveBeenCalledWith({
		type: 'h5SdkAction', target: 'service',
		body: { name: 'H5navigateTo', bridgeId: 'page-1', params: { url: './next', delta: undefined } },
	})
})

it('discards old frame messages and load events after src changes or unmount', async () => {
	const { frame, props, app } = mount()
	const oldFrame = frame(), oldWindow = oldFrame.contentWindow
	props.src = 'https://card.example/next'
	await nextTick()
	expect(frame()).not.toBe(oldFrame)
	message(oldWindow, 'old')
	oldFrame.dispatchEvent(new Event('load'))
	oldFrame.dispatchEvent(new Event('error'))
	expect(window.__message.send).not.toHaveBeenCalled()
	frame().dispatchEvent(new Event('load'))
	expect(window.__message.send.mock.calls[0][0].body.event.detail).toEqual({ src: props.src })
	const current = frame().contentWindow
	app.unmount()
	window.__message.send.mockClear()
	message(current, 'detached')
	expect(window.__message.send).not.toHaveBeenCalled()
})

it('preserves native default and cleans up the old native identity when changing modes', async () => {
	const { frame, props, host } = mount({ embedded: false })
	expect(host.querySelector('embed')).not.toBeNull()
	expect(window.__message.invoke.mock.calls[0][0].body.name).toBe('componentMount')
	props.id = 'new-card'
	props.embedded = true
	await nextTick()
	expect(frame()).not.toBeNull()
	const unmount = window.__message.invoke.mock.calls.find(([msg]) => msg.body.name === 'componentUnmount')[0]
	expect(unmount.body.params.id).toBe('card')
	expect(window.__message.off).toHaveBeenCalledTimes(3)
	props.embedded = false
	await nextTick()
	expect(window.__message.invoke.mock.calls.at(-1)[0].body.params.id).toBe('new-card')
	expect(window.__message.invoke.mock.calls.at(-1)[0].body.name).toBe('componentMount')
})

it('rejects executable embedded URLs and emits error without a success event', () => {
	const { frame } = mount({ src: 'javascript:alert(1)' })
	expect(frame().getAttribute('src')).toBe('about:blank')
	frame().dispatchEvent(new Event('load'))
	expect(window.__message.send).toHaveBeenCalledTimes(1)
	expect(window.__message.send.mock.calls[0][0].body.methodName).toBe('failed')
})

it('keeps embedded H5 away from Android legacy native interfaces', () => {
	platform.isAndroid = true
	window.DiminaRenderBridge = { supportsEmbeddedWebView: () => false }
	const { frame } = mount()
	expect(frame().getAttribute('src')).toBe('about:blank')
	expect(window.__message.send.mock.calls[0][0].body.methodName).toBe('failed')
})

it('does not apply the Android kernel gate to a Harmony UA containing Android', () => {
	platform.isAndroid = true
	platform.isHarmonyOS = true
	window.DiminaRenderBridge = { invoke: vi.fn() }
	const { frame } = mount()
	expect(frame().getAttribute('src')).toBe('https://card.example/form')
	expect(window.__message.send).not.toHaveBeenCalled()
})

it.each([{ mapRenderer: 'web' }, { supportsEmbeddedWebView: () => true }])('allows mobile Web and isolated Android hosts', (bridge) => {
	platform.isAndroid = true
	window.DiminaRenderBridge = bridge
	const { frame } = mount()
	expect(frame().getAttribute('src')).toBe('https://card.example/form')
	expect(window.__message.send).not.toHaveBeenCalled()
})

it('preserves the desktop full-screen class and legacy raw message payload', () => {
	platform.isDesktop = true
	const { frame } = mount({ embedded: false })
	expect(frame().classList.contains('dd-web-view-pc')).toBe(true)
	message(frame().contentWindow, { legacy: true })
	expect(window.__message.send.mock.calls[0][0].body.event.detail).toEqual({ data: { legacy: true } })
})
