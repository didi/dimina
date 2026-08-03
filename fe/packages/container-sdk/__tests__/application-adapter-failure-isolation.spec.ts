import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 _presentView/_dismissView/removeFailedView 实际会摸到的最小字段集：
// Application.el 是真实 DOM 节点（this.el.appendChild(view.el) 需要真 Node），故 view.el
// 用真实 document.createElement 而不是纯桩对象。与 application-transition-integrity.spec.ts /
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

describe('Application.removeFailedView restores the predecessor view when the removed view was presented over it', () => {
	it('restores viewA to foreground when the newly-failed viewB was on top of the stack', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })

		const viewA = createFakeView('app-a')
		await application.presentView(viewA, false)
		expect(application.views).toEqual([viewA])

		// 复现 _presentView 在把某个新 view 呈现到 viewA 之上时，会先对 viewA（这里的
		// preView）做的事：见 src/pages/application/application.ts 里
		// `preView?.onPresentOut()` 与 `preView?.el.classList.add('dimina-native-view--presenting')`。
		// 触发这套状态的真实场景是并发的 initApp() 失败（完整走一遍需要接入 MiniApp
		// 的启动流程，不在本文件范围内），这里直接落地它留下的前置状态。
		viewA.onPresentOut()
		viewA.el.classList.add('dimina-native-view--presenting')

		// viewB 是即将失败的新实例：尚未经过 presentView() 的完整呈现流程，直接被
		// 上游（真实场景中是 MiniApp.initApp() 的调用方）放进展示栈，随后启动失败。
		const viewB = createFakeView('app-b')
		application.views.push(viewB)

		await application.removeFailedView(viewB)

		// viewB 必须被摘除。
		expect(application.views).toEqual([viewA])

		// 今天的 bug：removeFailedView 只摘除 viewB 本身，完全不管 viewA——viewA 已经
		// 被打上了"退到后台"的生命周期事件与 class，摘除 viewB 之后没有任何代码把
		// viewA 的前台状态恢复回来，容器画面停在一个空白/背景态上。
		expect(viewA.onPresentIn).toHaveBeenCalled()
		expect(viewA.el.classList.contains('dimina-native-view--presenting')).toBe(false)
		expect(viewA.restoreColorStyle).toHaveBeenCalled()
	}, 10000)
})

describe('Application._presentView treats a throwing restoreColorStyle() as fully absorbed in the NORMAL (non-already-top) cached-reentry branch, matching the syncUrl() adapter contract', () => {
	it('resolves and still calls syncUrl() when re-presenting a cached view that is NOT currently on top and whose restoreColorStyle() throws', async () => {
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
		expect(syncStack).toHaveBeenCalledTimes(2)

		// 再次呈现 viewA，useCache:true。此时 viewA 不是栈顶（viewB 才是），命中的是
		// _presentView 主体里"正常"的缓存重入分支——不是"已经是栈顶"短路分支。
		viewA.restoreColorStyle = vi.fn(() => {
			throw new Error('color-restore-boom-normal-branch')
		})

		// 修正后的契约：配色恢复最终摸到的宿主 shell.updateStatusBarColor 与
		// urlSync 适配器一样是宿主可控代码，抛错是一次 best-effort 旁路失败，
		// 完全吸收——不再向上传播，presentView() 本身照常 resolve。
		await expect(application.presentView(viewA, true)).resolves.toBeUndefined()

		// 转场其余的提交工作必须真实完成：`view.restoreColorStyle()` 在这条分支里
		// 紧跟在 preView.onPresentOut()/view.onPresentIn()/this.views.push(view)
		// 之后、`await nextFrame()` 之前同步抛错，但这次转场其余的提交工作
		// （viewB 已经收到 onPresentOut()、viewA 已经收到 onPresentIn()、栈已经
		// 重排、地址栏同步）都必须真实发生。
		expect(syncStack).toHaveBeenCalledTimes(3)
	}, 10000)
})

describe('Application._presentView isolates a throwing host urlSync adapter from the transition result', () => {
	it('presentView still resolves when urlSync.syncStack throws after the transition has already fully committed', async () => {
		const syncStack = vi.fn(() => {
			throw new Error('sync-boom')
		})
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })
		const viewA = createFakeView('app-a')

		// 今天的 bug：_presentView 末尾无保护地调用 this.syncUrl()（line 205），
		// 此时 DOM/生命周期/展示栈都已经提交完毕——只是"通知地址栏"这个 best-effort
		// 步骤失败了，不应该让调用方以为呈现本身失败了。MiniApp 侧同类导航方法已经
		// 通过 safeSyncUrl() 做了这层隔离，Application 自己内部的 syncUrl() 调用点
		// 目前还没有对齐。
		await expect(application.presentView(viewA, false)).resolves.toBeUndefined()

		// 转场本身必须真实完成：viewA 进栈、拿到前台生命周期回调。
		expect(application.views).toContain(viewA)
		expect(viewA.onPresentIn).toHaveBeenCalled()
	}, 10000)
})

describe('Application._dismissView isolates a throwing host urlSync adapter from the dismissal result', () => {
	it('dismissView still resolves when urlSync.syncStack throws after the dismissal has already fully committed', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const application = new Application({ urlSync: { syncStack, clear } })
		const viewA = createFakeView('app-a')
		const viewB = createFakeView('app-b')

		await application.presentView(viewA, false)
		await application.presentView(viewB, false)
		expect(application.views).toEqual([viewA, viewB])

		// dismissView(viewB) 摘除栈顶后，新的栈顶是 viewA，_dismissView 末尾的
		// this.syncUrl()（line 270）会以 viewA 为 top 调 urlSync.syncStack()——只让
		// 这一次调用抛错，模拟宿主适配器在"关闭动画已经播完、DOM 已经清理"之后才
		// 出错的真实场景（对照 AppManager.closeApp 的真实调用形状）。
		syncStack.mockImplementationOnce(() => {
			throw new Error('dismiss-sync-boom')
		})

		// 今天的 bug：_dismissView 末尾同样无保护地调用 this.syncUrl()，viewB 已经
		// 真实销毁、移出 DOM、从展示栈弹出之后，仅仅因为地址栏同步失败就让整个
		// dismissView() 调用 reject，跟"关闭本身失败了"完全混为一谈。
		await expect(application.dismissView(viewB, { destroy: true })).resolves.toBeUndefined()

		expect(application.views).toEqual([viewA])
		expect(viewB.destroy).toHaveBeenCalled()
	}, 10000)
})
