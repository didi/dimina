import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// 回归测试：Application._enqueue() 把队列串成 `this._queue = this._queue.then(() => fn())`，
// 只挂 onFulfilled、不挂 onRejected。一旦某次 presentView/dismissView 的真实工作
// （包含调用宿主 urlSync 适配器，宿主代码可能抛错）reject，`this._queue` 就永久变成
// reject 态：往后任何 presentView/dismissView 调用的 `.then(() => fn())` 在一个已
// reject 的 promise 上只会原样透传 reject，`fn()`（真正干活的 _presentView/_dismissView）
// 永远不会再被调用——容器从此再也无法打开/关闭/切换小程序视图。
//
// 对照 AppManager.openApp 已经用 `this._openQueue = result.catch(() => {})` 挡住了
// 同类问题（见 src/core/appManager.ts），Application._enqueue 目前没有等价保护。
//
// fake view 只填 _presentView 实际会摸到的最小字段集：Application.el 是真实 DOM
// 节点（this.el.appendChild(view.el) 需要真 Node），故 view.el 用真实
// document.createElement 而不是纯桩对象。

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

describe('Application._enqueue does not permanently poison the presentView/dismissView queue after one operation fails', () => {
	it('a later presentView() actually runs its real work (pushes the view, calls onPresentIn) after an earlier presentView() failed', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })

		// this.syncUrl() 末尾调用现在已经用 safeSyncUrl() 包装（见
		// application-adapter-failure-isolation.spec.ts 的 F5），urlSync 适配器抛错
		// 不再让 presentView() 的 promise reject，所以这里改用 viewDidLoad()：它在
		// `this.views.push(view)` 之后、useCache:false 时无条件同步调用，不受任何
		// safe* 保护，仍然能在 push 之后触发一次真实的中途 reject，用来验证队列
		// 本身不会被这次失败永久污染。
		const viewA = createFakeView('app-a', {
			viewDidLoad: vi.fn(() => {
				throw new Error('boom')
			}),
		})
		const viewB = createFakeView('app-b')

		// 第一次 presentView：_presentView 内部在 this.views.push(view) 之后紧跟着
		// 调用 viewDidLoad() 抛错，这次调用自己的 promise 必须 reject。
		await expect(application.presentView(viewA, false)).rejects.toThrow('boom')

		// 抛错发生在 viewDidLoad() 里，晚于 this.views.push(view)（_presentView 前半段），
		// 所以 viewA 的真实呈现工作已经做了一部分——它应该已经在展示栈里。
		expect(application.views).toContain(viewA)

		// 第二次 presentView：viewB 是全新实例，不受 viewA 的 viewDidLoad mock 影响。
		// 今天的 bug 是 this._queue 已经永久 reject，_enqueue() 里
		// `this._queue.then(() => fn())` 对一个已 reject 的 promise 只会原样透传
		// reject，不会调用 fn —— 也就是说 _presentView(viewB, ...) 的真实逻辑根本
		// 不会执行。这里不对这次调用自己的 promise 是否 resolve 做任何断言（无论
		// 修复前后，透传的 reject 都可能让它 reject），只关心真实工作是否发生。
		await application.presentView(viewB, false).catch(() => {})

		// 这才是本测试要守护的不变量：viewB 必须真的被呈现——推入展示栈、
		// 触发 onPresentIn ——而不是这次调用的 promise 平白无故地"结束"了，
		// 实际 _presentView(viewB, ...) 从未被调用过。
		expect(application.views).toContain(viewB)
		expect(viewB.onPresentIn).toHaveBeenCalled()
	}, 10000)
})
