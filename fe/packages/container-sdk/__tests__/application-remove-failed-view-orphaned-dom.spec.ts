import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 removeFailedView 实际会摸到的最小字段集：Application.el 是真实 DOM
// 节点，故 view.el 用真实 document.createElement 而不是纯桩对象。与
// application-transition-integrity.spec.ts 保持同一 fixture 形状。

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

// 契约：removeFailedView() 目前靠 `this.views.indexOf(view) === -1` 直接 return，
// 完全跳过后面的 `view.el.parentNode?.removeChild(view.el)`。但"不在 this.views 里"
// 和"DOM 上没有残留元素"不是同一件事——_dismissView(view, {destroy:false}) 的非栈顶
// 分支就是一个真实、可达的反例：它把 view 从 this.views 摘掉，但故意保留 view.el
// 挂在 DOM 上以便缓存复用（见 application.ts 275 行附近的非 destroy 分支注释）。
// 如果同一个 view 后续被判定为永久启动失败并交给 removeFailedView() 处理，它此时
// 已经不在 this.views 里了，但 view.el 依然是一个真实挂在 DOM 上的孤儿节点——今天
// 的早退直接把这块清理跳过，孤儿节点永远留在 DOM 上。

describe('Application.removeFailedView() still removes an orphaned DOM element even when the view is not found in application.views', () => {
	it('removes view.el from its parent even though view was never pushed into application.views', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })
		const view = createFakeView('app-orphan')

		// 直接把 view.el 挂到一个父节点下，模拟 _dismissView(view, {destroy:false})
		// 非栈顶分支留下的真实状态：DOM 上有它，但 application.views 里没有它——
		// 这里干脆不 push，直接复现"从未在/已经不在 views 里"这个前提条件。
		const parent = document.createElement('div')
		parent.appendChild(view.el)
		expect(view.el.parentNode).toBe(parent)
		expect(application.views).not.toContain(view)

		await application.removeFailedView(view)

		expect(view.el.parentNode).toBeNull()
	}, 10000)
})
