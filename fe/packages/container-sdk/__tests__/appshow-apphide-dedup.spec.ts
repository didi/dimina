import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { JSCore } from '../src/core/jscore.js'

// 契约：appShow/appHide 是 app 粒度信号（一个 MiniApp 的所有页面 Bridge 共享同一个
// JSCore/Worker），记账因此必须收在 JSCore 上，不能像 pageShow/pageHide 那样分别挂在
// 各个 Bridge 上——否则多页面/多 tab 各自一份状态会互相踩踏（tab A 已发过 appHide，
// tab B 从未发过却因为自己独立的一份"未发送"状态被误判成需要重发，或者反过来该发的
// 一次被当成重复吞掉）。这里直接在 JSCore 层面验证同方向去重、跨方向放行。

function createJSCore(): { jscore: JSCore, workerPostMessage: ReturnType<typeof vi.fn> } {
	const fakeParent = { _destroyed: false } as unknown as MiniApp
	const jscore = new JSCore(fakeParent)
	const workerPostMessage = vi.fn()
	// 绕开真实 init()（会真的起一个 Worker）：直接把 worker 设成一个可观测的桩，
	// 只关心 appShow/appHide 的去重逻辑本身，不关心 Worker 创建流程。
	jscore.worker = { postMessage: workerPostMessage, terminate: vi.fn() } as unknown as Worker
	// 这里只关心去重逻辑，不关心"就绪后补发"那套时序（见
	// jscore-app-visibility-catchup.spec.ts），所以直接让 service 侧标记为已就绪，
	// 让 appShow/appHide 立即生效。
	jscore.notifyServiceReady()
	return { jscore, workerPostMessage }
}

function callsOfType(postMessage: ReturnType<typeof vi.fn>, type: string): number {
	return postMessage.mock.calls.filter(([message]) => (message as { type: string }).type === type).length
}

describe('JSCore.appShow/appHide must dedupe repeated same-direction signals at the shared app level', () => {
	it('does not re-post appHide when appHide is called twice in a row', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()
		jscore.appHide()

		expect(callsOfType(workerPostMessage, 'appHide')).toBe(1)
	})

	it('allows a direction change to appShow, then dedupes a repeated appShow', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()
		jscore.appHide()
		expect(callsOfType(workerPostMessage, 'appHide')).toBe(1)

		// 方向切换：appShow 是全新方向，必须真的发出去。
		jscore.appShow()
		expect(callsOfType(workerPostMessage, 'appShow')).toBe(1)

		// 同方向重复调用：不应再次发送。
		jscore.appShow()
		expect(callsOfType(workerPostMessage, 'appShow')).toBe(1)
	})

	it('does not require page-level resource loading — only service-side readiness (via notifyServiceReady) matters', () => {
		// 回归 round 10 codex 发现的问题：旧实现（挂在 Bridge 上）用页面级
		// isResourceLoaded() 当就绪判据，导致某个具体页面资源还没加载完时，
		// app 级 appHide/appShow 会被直接丢弃且永不补发。app 级信号的就绪判据
		// 是 service 侧 App 是否已构造（notifyServiceReady()），与某个具体页面的
		// service/render 资源是否都已加载完成无关（这两件事分属不同粒度）。
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()

		expect(callsOfType(workerPostMessage, 'appHide')).toBe(1)
	})

	it('drops the call (without corrupting dedup state) when the worker does not exist yet, matching postMessage()\'s own null-guard', () => {
		const fakeParent = { _destroyed: false } as unknown as MiniApp
		const jscore = new JSCore(fakeParent)
		// service 侧已就绪，但 worker 从未被设置（未调用 init()）——appHide() 应该
		// 安静地经 postMessage() 的判空吸收掉，不抛错。
		jscore.notifyServiceReady()
		expect(() => jscore.appHide()).not.toThrow()
	})

	it('resets dedup state on destroy() so a later reused JSCore does not incorrectly suppress the next call', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()
		expect(callsOfType(workerPostMessage, 'appHide')).toBe(1)

		jscore.destroy()

		const newWorkerPostMessage = vi.fn()
		jscore.worker = { postMessage: newWorkerPostMessage } as unknown as Worker
		// destroy() 同时把 serviceReady 重置为 false（新一轮生命周期需要重新
		// 走一次 notifyServiceReady()，不能沿用上一轮的就绪状态）。
		jscore.notifyServiceReady()

		jscore.appHide()
		expect(callsOfType(newWorkerPostMessage, 'appHide')).toBe(1)
	})
})
