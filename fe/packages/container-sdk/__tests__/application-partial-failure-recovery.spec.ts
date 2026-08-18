import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 _presentView/_dismissView 实际会摸到的最小字段集：Application.el 是
// 真实 DOM 节点（this.el.appendChild(view.el) 需要真 Node），故 view.el 用真实
// document.createElement 而不是纯桩对象。与 application-queue-recovery.spec.ts 保持
// 同一 fixture 形状。

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

describe('Application._presentView leaves `this.done` stuck when a mid-flight call throws', () => {
	it('a later presentView() still runs its real work after an earlier presentView() threw between done=false and done=true', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })

		// view.restoreColorStyle() 和 this.syncUrl() 现在都已经用 safe* 包装、不再
		// 让转场以外的旁路失败中途跳出 try 块（见 application-adapter-failure-
		// isolation.spec.ts 的 F3/F4/F5），所以这里改用 onPresentIn()：它紧跟在
		// `this.done = false` 之后同步调用，且不受今天任何一处 safe* 保护，仍然是
		// _presentView 主体中离 done=false 最近、最容易触发的一个中途抛错点。
		const viewA = createFakeView('app-a', {
			onPresentIn: vi.fn(() => {
				throw new Error('boom')
			}),
		})

		// 第一次 presentView：`this.done = false` 之后、`this.done = true` 之前的
		// view.onPresentIn() 抛错，这次调用自己的 promise 必须 reject。
		await expect(application.presentView(viewA, true)).rejects.toThrow('boom')

		// 今天的 bug：`this.done` 在这次抛错后永久停在 false（只有 _presentView
		// 末尾"正常路径"才会把它设回 true，中途抛错没有 finally 兜底）。
		// _presentView/_dismissView 开头都有 `if (!this.done) { return }` 这道闸门，
		// 一旦 done 卡死，之后任何 presentView/dismissView 调用都会被这道闸门直接
		// 静默 no-op 掉——甚至不会真正尝试去做任何事，容器从此彻底瘫痪。
		//
		// 这不是 application-queue-recovery.spec.ts 已经覆盖的"队列被污染"问题
		// （那个 bug 出在 _enqueue 的 promise 链上，且已经用 `.catch(() => {})`
		// 挡住了）；这里守护的是一个独立的、依然存在的 done 标志位卡死问题——
		// 只修队列不修 done，容器照样是坏的。
		const viewB = createFakeView('app-b')
		await application.presentView(viewB, false)

		// 断言真实副作用发生了（推入展示栈、触发 onPresentIn），而不只是
		// promise 平白无故地 resolve/settle——避免"闸门放行但 body 其实没跑"
		// 这种假绿。
		expect(application.views).toContain(viewB)
		expect(viewB.onPresentIn).toHaveBeenCalled()
	}, 10000)
})

describe('Application._presentView does not de-duplicate a retried view already left in `this.views` by a failed attempt', () => {
	it('retrying presentView() for the same view object after an earlier failed attempt does not duplicate it in application.views', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })

		// this.syncUrl() 末尾调用现在已经用 safeSyncUrl() 包装（见
		// application-adapter-failure-isolation.spec.ts 的 F5），urlSync 适配器抛错
		// 不再让 presentView() 的 promise reject，所以这里改用 viewDidLoad()：它在
		// `this.views.push(view)` 之后、useCache:false 时无条件同步调用，且不受
		// 任何 safe* 保护，仍然能在 push 之后触发一次真实的中途 reject。
		const viewA = createFakeView('app-a', {
			viewDidLoad: vi.fn(() => {
				throw new Error('boom')
			}),
		})

		// 第一次 presentView：`this.views.push(view)` 发生在 _presentView 前半段，
		// 抛错发生在紧随其后的 viewDidLoad() 里（晚于 push），所以这次调用会
		// reject，但 viewA 已经被真实推入了展示栈。
		await expect(application.presentView(viewA, false)).rejects.toThrow('boom')
		expect(application.views).toContain(viewA)

		// 调用方按真实重试形状重试：对已经失败过的同一个 view 对象再调用一次
		// presentView，这次带 useCache:true（对照 AppManager._openApp 缓存命中
		// 分支对已注册 app 重新呈现时的调用方式）。useCache:true 时 viewDidLoad()
		// 根本不会被调用（`!useCache && view.viewDidLoad && view.viewDidLoad()`），
		// 调用应当成功。
		//
		// 注意：这次重试时 viewA 已经是 application.views 里唯一/栈顶的元素
		// （上一次失败的尝试已经把它 push 了进去），所以命中的其实是 _presentView
		// 开头"已经是栈顶"短路分支（`this.views[this.views.length - 1] === view`），
		// 而不是本测试标题所指、后半段真正做 `indexOf` + `splice` + `push` 去重的
		// 那段逻辑——短路分支根本不碰 this.views，本来就不会产生重复。这段代码本身
		// 仍然是对"已经是栈顶时重复呈现不出问题"这一独立契约的有效保护，只是不再
		// 覆盖它标题所说的去重 splice/push 分支；下面新增的测试单独覆盖非栈顶场景
		// 下真正走到 splice/push 的去重逻辑。
		await application.presentView(viewA, true)

		expect(application.views.filter(v => v === viewA).length).toBe(1)
	}, 10000)
})

describe('Application._presentView de-duplicates a retried non-top view via the real indexOf+splice+push path', () => {
	it('retrying presentView() for a NON-TOP cached view after an earlier attempt failed partway through does not duplicate it in application.views', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })

		const viewA = createFakeView('app-a')
		const viewB = createFakeView('app-b')

		// viewA 呈现后又被 viewB 盖过去：viewA 不再是栈顶，两个 view 都还在
		// application.views 里（真实的 destroy:false 缓存语义）。
		await application.presentView(viewA, false)
		await application.presentView(viewB, false)
		expect(application.views).toEqual([viewA, viewB])

		// 第一次重试 viewA：在 `preView.onPresentOut()`（此时 preView 是 viewB）
		// 之后、`existingIndex`/`splice`/`push` 这段去重逻辑之前同步抛错，模拟
		// "重试请求中途失败"——这次失败不触碰 this.views，viewA 仍然停留在原来的
		// 非栈顶位置，不产生任何去重风险（本来也不该产生）。
		viewA.onPresentIn = vi.fn(() => {
			throw new Error('retry-attempt-1-boom')
		})
		await expect(application.presentView(viewA, true)).rejects.toThrow('retry-attempt-1-boom')
		expect(application.views).toEqual([viewA, viewB])

		// 第二次重试（真正的"重试"）：viewA 依然不是栈顶（viewB 才是），这次成功
		// 走完，命中的是 _presentView 主体里真正做 `indexOf` + `splice` + `push`
		// 去重的那段逻辑——而不是"已经是栈顶"短路分支。
		viewA.onPresentIn = vi.fn()
		await application.presentView(viewA, true)

		expect(application.views).toEqual([viewB, viewA])
		expect(application.views.filter(v => v === viewA).length).toBe(1)
	}, 10000)
})
