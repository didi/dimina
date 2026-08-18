import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 destroyRootView/_dismissView 实际会摸到的最小字段集：Application.el/
// window 是真实 DOM 节点，故 view.el 用真实 document.createElement 而不是纯桩对象。
// 与 application-transition-integrity.spec.ts / application-adapter-failure-isolation.spec.ts
// 保持同一 fixture 形状。

function createFakeView(appId: string, overrides: Partial<Record<string, unknown>> = {}): MiniApp {
	const view: Record<string, unknown> = {
		appId,
		el: document.createElement('div'),
		parent: null,
		onPresentIn: vi.fn(),
		onPresentOut: vi.fn(),
		viewDidLoad: vi.fn(),
		restoreColorStyle: vi.fn(),
		destroy: vi.fn(),
		getPageStack: vi.fn(() => []),
		...overrides,
	}
	return view as unknown as MiniApp
}

// 契约：MiniApp.destroy() 现在可能在完成自己全部内部收尾之后，因为一个行为不当的
// 扩展模块 unsubscribe 函数而重新抛出错误（见 destroy-survives-throwing-ext-unsubscribe.spec.ts）
// ——`.destroy()` 抛错因此是每个调用方都必须容错的真实场景，而不是只在测试里才
// 会出现的极端情况。destroyRootView()/_dismissView(..., {destroy:true}) 目前都在
// `view.destroy()` 后面无保护地紧跟结构性清理（从 this.views 摘除、从 DOM 摘除
// view.el），destroy() 一抛错，try 块（或代码顺序）就中途中断，结构性清理完全
// 跳过——尽管 view 自身已经真实、完整地销毁完毕。

describe('Application.destroyRootView() still performs structural cleanup when view.destroy() throws', () => {
	it('still removes the view from application.views and from its DOM parent despite destroy() throwing', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })
		const view = createFakeView('app-root', {
			destroy: vi.fn(() => {
				throw new Error('destroy-boom')
			}),
		})

		// 模拟 destroyRootView() 真实调用时的前置状态：view 已经登记进
		// application.views，view.el 已经挂在某个父节点下（真实场景里是
		// initRootView() 挂到 this.window，或 presentView() 挂到 this.el；这里用
		// this.window，跟 initRootView() 的真实挂载点保持一致）。
		application.views.push(view)
		application.window.appendChild(view.el)
		expect(view.el.parentNode).toBe(application.window)

		// destroyRootView() 自身的 promise 是否 reject/resolve 不是本测试的关注点——
		// destroy() 抛错本身允许被感知；关注点是结构性清理有没有照常跑完。用
		// catch 吸收，避免 unhandled rejection 干扰断言。
		await application.destroyRootView(view).catch(() => {})

		expect(application.views).not.toContain(view)
		expect(view.el.parentNode).toBeNull()
	}, 10000)
})

describe('Application._dismissView({destroy:true}) still performs structural cleanup when view.destroy() throws, on the currently-top branch', () => {
	it('still removes the top view from application.views and from the DOM despite destroy() throwing', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })
		const viewA = createFakeView('app-a')
		const viewB = createFakeView('app-b', {
			destroy: vi.fn(() => {
				throw new Error('destroy-boom')
			}),
		})

		await application.presentView(viewA, false)
		await application.presentView(viewB, false)
		expect(application.views).toEqual([viewA, viewB])
		expect(viewB.el.parentNode).toBe(application.el)

		// viewB 是当前栈顶：命中 _dismissView 里"当前栈顶"分支，`currentView.destroy()`
		// 与 `this.el.removeChild(currentView.el)`/`this.views.pop()` 都在同一个
		// try 块里，destroy() 抛错会让 removeChild 和 pop 都跑不到。
		await application.dismissView(viewB, { destroy: true }).catch(() => {})

		expect(application.views).not.toContain(viewB)
		expect(viewB.el.parentNode).toBeNull()
	}, 10000)
})

describe('Application._dismissView({destroy:true}) still performs structural cleanup when view.destroy() throws, on the non-top branch', () => {
	it('still removes the non-top view from application.views and from the DOM despite destroy() throwing', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })
		const viewA = createFakeView('app-a', {
			destroy: vi.fn(() => {
				throw new Error('destroy-boom')
			}),
		})
		const viewB = createFakeView('app-b')

		await application.presentView(viewA, false)
		await application.presentView(viewB, false)
		expect(application.views).toEqual([viewA, viewB])
		expect(viewA.el.parentNode).toBe(application.el)

		// viewA 不是当前栈顶（viewB 才是）：命中 _dismissView 里"非栈顶"分支。
		// `this.views.splice(index, 1)` 在这条分支里排在 `view.destroy()` 之前，
		// 所以 views 摘除今天已经能正常发生；真正被 destroy() 抛错挡住的是紧跟
		// 在后面的 `view.el.parentNode?.removeChild(view.el)` 这一句 DOM 清理。
		await application.dismissView(viewA, { destroy: true }).catch(() => {})

		expect(application.views).not.toContain(viewA)
		expect(viewA.el.parentNode).toBeNull()
	}, 10000)
})
