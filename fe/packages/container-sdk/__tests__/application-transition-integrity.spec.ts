import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 _presentView/_dismissView 实际会摸到的最小字段集：Application.el 是
// 真实 DOM 节点（this.el.appendChild(view.el) 需要真 Node），故 view.el 用真实
// document.createElement 而不是纯桩对象。与 application-queue-recovery.spec.ts /
// application-partial-failure-recovery.spec.ts 保持同一 fixture 形状。

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

describe('Application.removeFailedView is not serialized through the same queue as presentView/dismissView', () => {
	it('does not run its removal while another view is still mid-flight inside _presentView', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })

		// viewA 模拟一个真实的失败启动场景：某个上游流程（对照
		// src/pages/miniApp/miniApp.ts 的 initApp() catch 分支）已经把它直接放进
		// 展示栈，但它从未经过 presentView() 的正常呈现流程就失败了——它跟下面
		// 正在呈现的 viewB 是完全独立的两个实例。
		const viewA = createFakeView('app-a')
		application.views.push(viewA)

		const viewB = createFakeView('app-b')
		const order: string[] = []

		// 不 await：presentView(viewB) 内部会在
		// `await waitTransitionEnd(view.el, 'transform')` 处真实挂起
		// WAIT_TRANSITION_TIMEOUT_MS（560ms）——这是 _presentView 里离
		// this.done 重置最近的一个货真价实的异步间隙。
		const presentBPromise = application.presentView(viewB, false).then(() => {
			order.push('presentView-B-done')
		})

		// 给 nextFrame()（两次 requestAnimationFrame）留出真实时间跑完，确保这里
		// 拿到的是"viewB 已经卡在 waitTransitionEnd 里"这个状态，而不是还没进入
		// _presentView 主体。50ms 远小于 560ms 的超时兜底，removeFailedView 一定
		// 发生在 viewB 呈现完成之前。
		await new Promise(resolve => setTimeout(resolve, 50))

		// removeFailedView 目前完全绕开 _enqueue/_queue 串行化，同步直接摸
		// this.views 和 DOM。如果它真的经过同一条队列串行化，这次调用应该排在
		// viewB 的 presentView 之后才执行；今天它会立刻同步执行。
		// 必须 await 这次调用本身再 push，否则不管实现是否真的排队，push 都会在
		// 调用发起的那一刻（~52ms）同步记录，测不出"排队等待"和"立刻执行"的区别。
		await application.removeFailedView(viewA)
		order.push('removeFailedView-A-done')

		await presentBPromise

		expect(order).toEqual(['presentView-B-done', 'removeFailedView-A-done'])
	}, 10000)
})

describe('Application._presentView treats a throwing restoreColorStyle() as fully absorbed on the already-topmost view, matching the syncUrl() adapter contract', () => {
	it('resolves and still runs syncUrl() even though the useCache restoreColorStyle() step throws mid-transition', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })
		const viewA = createFakeView('app-a')

		// 第一次 presentView：非缓存路径，正常走完整个呈现流程，syncUrl() 被调用一次。
		await application.presentView(viewA, false)
		expect(syncStack).toHaveBeenCalledTimes(1)

		// 第二次 presentView 走 useCache:true 分支，restoreColorStyle() 紧跟在
		// preView.onPresentOut()/view.onPresentIn()/this.views.push(view) 之后同步
		// 抛错（对照真实场景：restoreColorStyle 最终会摸到宿主 shell.updateStatusBarColor，
		// 宿主实现可能抛错）。viewA 此时已经是唯一/栈顶实例，命中的是"已经是栈顶"
		// 短路分支。
		viewA.restoreColorStyle = vi.fn(() => {
			throw new Error('color-restore-boom')
		})

		// 修正后的契约：配色恢复最终摸到的宿主 shell.updateStatusBarColor 与
		// urlSync 适配器一样是宿主可控代码，抛错同样只是一次 best-effort 旁路失败，
		// 完全吸收，不冒充"这次呈现本身失败了"——不再是"其余工作跑完后仍重新
		// 抛出"的半吸收状态。
		await expect(application.presentView(viewA, true)).resolves.toBeUndefined()

		// 转场其余的提交工作必须真实完成：syncUrl() 仍然跑到了。
		expect(syncStack).toHaveBeenCalledTimes(2)
	}, 10000)
})

describe('Application._presentView is idempotent when re-presenting the view already at the top of the stack', () => {
	it('does not run a self present/dismiss transition on the already-topmost view', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })
		const viewA = createFakeView('app-a')

		// 先正常呈现 viewA，成为展示栈唯一/最顶层的实例。
		await application.presentView(viewA, false)
		expect(application.views).toEqual([viewA])
		expect(viewA.onPresentOut).toHaveBeenCalledTimes(0)
		expect(viewA.el.classList.contains('dimina-native-view--presenting')).toBe(false)

		// 再次对同一个已经是栈顶的 view 调用 presentView（真实触发场景：
		// AppManager 对已经是当前 app 的实例重新 openApp()，或某次更早失败后的
		// 重试，中间没有呈现过任何其它 view）。
		await application.presentView(viewA, true)

		// 今天的 bug：_presentView 无条件把 `preView = this.views[this.views.length - 1]`
		// 当作"正在被替换掉的另一个实例"来对待——而这里 preView 就是 view 自己。
		// 于是同一个 MiniApp 实例会收到一次自己对自己的 onPresentOut()，
		// 并且被加上本该属于"退到后台的旧实例"的 --presenting class，而摘除
		// --presenting 的逻辑只在非缓存的完整摘除路径上跑，这里永远不会有人再
		// 把它摘掉。
		expect(viewA.onPresentOut).toHaveBeenCalledTimes(0)
		expect(viewA.el.classList.contains('dimina-native-view--presenting')).toBe(false)
		expect(application.views).toEqual([viewA])
	}, 10000)
})
