import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import loader from '../src/core/loader'
import message from '../src/core/message'
import runtime from '../src/core/runtime'

let frames, scrollTop
beforeEach(() => {
	document.body.innerHTML = ''
	frames = new Map(); let frameId = 0; scrollTop = 0
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++frameId, fn); return frameId })
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
	vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollTop)
	vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
	Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
	vi.spyOn(message, 'send').mockImplementation(() => {})
	vi.spyOn(message, 'invoke').mockImplementation(() => {})
	vi.spyOn(message, 'wait').mockResolvedValue({})
})
afterEach(() => { runtime.app?.unmount(); runtime.app = null; vi.restoreAllMocks() })
function flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }
function touch(type, x, y, target = document.body, count = 1) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.defineProperty(event, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: count }, () => ({ clientX: x, clientY: y })) })
	target.dispatchEvent(event); return event
}
function pull(target = document.body) { touch('touchstart', 100, 50, target); touch('touchmove', 100, 230, target); touch('touchend', 100, 230, target) }
const events = type => message.send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === type)
async function mount(pageConfig = { enablePullDownRefresh: true }) {
	vi.spyOn(loader, 'getModuleByPath').mockReturnValue({ moduleInfo: { id: 'scroll-page', usingComponents: {}, pageConfig, render: () => Vue.h('div', { id: 'content' }, 'content') } })
	runtime.firstRender({ bridgeId: 'scroll-bridge', pageId: 'scroll-page', pagePath: 'index' })
	await vi.waitFor(() => expect(document.getElementById('content')).not.toBeNull())
	message.send.mockClear()
}

describe('mounted page scroll events (#373)', () => {
	it('starts one refresh and waits for stop before allowing another gesture', async () => {
		await mount(); pull(); pull()
		expect(events('pagePullDownRefresh')).toEqual([{ type: 'pagePullDownRefresh', target: 'service', body: { bridgeId: 'scroll-bridge', moduleId: 'scroll-page' } }])
		expect(typeof runtime.stopPullDownRefresh).toBe('function')
		runtime.stopPullDownRefresh({ bridgeId: 'scroll-bridge', params: {} }); pull()
		expect(events('pagePullDownRefresh')).toHaveLength(2)
	})
	it('honors disabled refresh and rejects horizontal, cancelled and multi-touch gestures', async () => {
		await mount({ enablePullDownRefresh: false }); pull(); expect(events('pagePullDownRefresh')).toHaveLength(0)
		await mount(); touch('touchstart', 0, 0); touch('touchmove', 180, 100); touch('touchend', 180, 100)
		touch('touchstart', 0, 0); touch('touchmove', 0, 180); touch('touchcancel', 0, 180)
		touch('touchstart', 0, 0, document.body, 2); touch('touchmove', 0, 180, document.body, 2); touch('touchend', 0, 180)
		expect(events('pagePullDownRefresh')).toHaveLength(0)
	})
	it('leaves nested scroll areas and non-top page drags alone', async () => {
		await mount(); const nested = document.createElement('div'); nested.style.overflowY = 'auto'; document.body.append(nested)
		Object.defineProperty(nested, 'scrollHeight', { value: 300 }); Object.defineProperty(nested, 'clientHeight', { value: 100 })
		pull(nested); scrollTop = 30; pull(); expect(events('pagePullDownRefresh')).toHaveLength(0)
	})
	it('fires once per bottom entry, honors zero distance, and preserves pageScroll', async () => {
		await mount({ onReachBottomDistance: 0 }); scrollTop = 1390; window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(0)
		scrollTop = 1400; window.dispatchEvent(new Event('scroll')); flush(); window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(1)
		scrollTop = 1200; window.dispatchEvent(new Event('scroll')); flush(); scrollTop = 1400; window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(2)
		expect(events('pageScroll').at(-1).body.scrollTop).toBe(1400)
	})
	it('uses the default 50px distance and cancels queued work on unmount', async () => {
		await mount({}); scrollTop = 1360; window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(1)
		window.dispatchEvent(new Event('scroll')); runtime.app.unmount(); runtime.app = null; message.send.mockClear(); flush(); pull()
		expect(events('pageScroll')).toHaveLength(0); expect(events('pagePullDownRefresh')).toHaveLength(0)
		expect(document.querySelector('[data-dimina-pull-down-refresh]')).toBeNull()
	})
	it('recognizes a fractional Android scroll offset at zero bottom distance', async () => {
		await mount({ onReachBottomDistance: 0 })
		scrollTop = 1399.75; window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(1)
	})
	it('measures the document scroller rather than a separately rounded body height', async () => {
		await mount({ onReachBottomDistance: 0 })
		Object.defineProperty(document.body, 'scrollHeight', { configurable: true, value: 2001 })
		scrollTop = 1399.75; window.dispatchEvent(new Event('scroll')); flush()
		expect(events('pageReachBottom')).toHaveLength(1)
	})
	it('routes start/stop callbacks and makes repeated start idempotent', async () => {
		await mount(); expect(typeof runtime.startPullDownRefresh).toBe('function')
		runtime.startPullDownRefresh({ bridgeId: 'scroll-bridge', params: { success: 'start-ok', complete: 'start-complete' } })
		runtime.startPullDownRefresh({ bridgeId: 'scroll-bridge', params: {} })
		expect(events('pagePullDownRefresh')).toHaveLength(1)
		expect(events('triggerCallback').map(msg => [msg.body.id, msg.body.args.errMsg])).toEqual([['start-ok', 'startPullDownRefresh:ok'], ['start-complete', 'startPullDownRefresh:ok']])
		runtime.stopPullDownRefresh({ bridgeId: 'scroll-bridge', params: { success: 'stop-ok' } })
		expect(events('triggerCallback').at(-1).body.args.errMsg).toBe('stopPullDownRefresh:ok')
		runtime.startPullDownRefresh({ bridgeId: 'another-page', params: { fail: 'wrong-page' } })
		expect(events('triggerCallback').at(-1).body.args.errMsg).toContain('startPullDownRefresh:fail')
		expect(events('pagePullDownRefresh')).toHaveLength(1)
	})
})
