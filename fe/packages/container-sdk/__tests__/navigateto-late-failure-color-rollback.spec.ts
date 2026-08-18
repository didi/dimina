import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：navigateTo() 的失败回滚（见 navigateto-color-rollback.spec.ts）只覆盖了
// createBridge() 本身 reject 的场景——那种场景下 updateTargetPageColorStyle() 从未
// 被调用过，this.color 本就还是原始值，catch 分支的 restoreColorStyle() 不做什么也
// 是"对的"（只是凑巧）。
//
// 这里覆盖的触发条件是：createBridge() 成功 resolve，updateTargetPageColorStyle()
// 已经真的把 this.color 提交成目标页配色，bridge 也已经 push 进栈并 start() 过，
// 紧接着的下一步（this.parent?.syncUrl()）才抛错。
//
// 地址栏同步是尽力而为的旁路通知（见 navigateto-syncurl-only-failure-reports-success.spec.ts）：
// syncUrl() 抛错已经被 safeSyncUrl() 统一收窄，不再冒充"这次跳转本身失败了"，也不再
// 中断已经完成的页面切换。这个场景里 createBridge/配色提交/push/start 全部真实成功，
// 唯一失败的只是地址栏同步——因此正确终态是 onSuccess，配色维持在真正生效的目标页配色，
// 而不是被回滚回跳转前的原始值。

function createElement(): HTMLElement {
	const element = {
		classList: {
			add: vi.fn(),
			remove: vi.fn(),
		},
		addEventListener: vi.fn((_type: string, handler: (event: { propertyName: string }) => void) => {
			handler({ propertyName: 'transform' })
		}),
		removeEventListener: vi.fn(),
		style: {},
		parentNode: {
			removeChild: vi.fn(),
		},
	}
	return element as unknown as HTMLElement
}

function createBridge(pagePath: string): Bridge {
	return {
		opts: { pagePath },
		destroy: vi.fn(),
		start: vi.fn(),
		pageShow: vi.fn(),
		pageHide: vi.fn(),
		webview: {
			el: createElement(),
		},
	} as unknown as Bridge
}

function createApp(): MiniApp {
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.appConfig = {
		app: {},
		modules: {
			'pages/first': {},
			// 空配置 -> mergePageConfig 默认 navigationBarTextStyle: 'white'，与下面
			// 模拟的当前页 'black' 刻意不同，这样才能观察到配色是否真的被回滚。
			'pages/second': {},
		},
	}
	app.appInfo = { scene: 1001, pagePath: 'pages/first', query: {} }
	app.appId = 'test-app'
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app.color = 'black' // 模拟已经处于当前页，配色是 black
	app._isTabBarPage = vi.fn(() => false)
	app._setTabBarVisible = vi.fn()
	app._syncHash = vi.fn()
	const actionEl = { classList: { add: vi.fn(), remove: vi.fn() } }
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniApp
}

function callbackIds(app: MiniApp): unknown[] {
	const postMessage = app.jscore.postMessage as unknown as ReturnType<typeof vi.fn>
	return postMessage.mock.calls.map(([message]) => (message as { body: { id: unknown } }).body.id)
}

describe('a navigateTo failure caused solely by syncUrl() throwing after the page transition already committed reports success, not a color rollback', () => {
	it('reports onSuccess and leaves this.color / the shell status-bar color at the committed target-page value when only syncUrl() throws after createBridge() resolved', async () => {
		const app = createApp()
		const preBridge = createBridge('pages/first')
		app.navigator.pushPage(preBridge)

		const updateStatusBarColor = vi.fn()
		const syncUrl = vi.fn(() => {
			throw new Error('host syncUrl adapter blew up')
		})
		app.parent = {
			updateStatusBarColor,
			syncUrl,
			getActiveView: vi.fn(() => app),
		} as unknown as MiniApp['parent']

		// createBridge 这次真的成功了——配色提交、push、start 都会真实发生，
		// 失败点被推迟到紧随其后的 syncUrl()，且 syncUrl() 的异常被 safeSyncUrl()
		// 收窄，不再中断这次已经完整跑完的页面切换。
		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// crux 1：地址栏同步失败不能冒充导航失败——页面切换本身完整跑完了，
		// 必须报告 onSuccess，不是 onFail。
		expect(callbackIds(app)).toEqual(['s', 'c'])

		// crux 2：目标页配色（'white'）已经被真实提交，且切换真正成功，
		// 不应该被回滚回跳转前的原始配色——回滚只属于"跳转本身失败"的语义，
		// 地址栏同步失败不再触发它。
		expect(app.color).toBe('white')
		expect(updateStatusBarColor).toHaveBeenLastCalledWith('white')

		// crux 3：报告的 onSuccess 必须对应一次真正完整的切换——旧页面已经
		// 真正被 pageHide() 过，不是一次"半成品"切换被包装成成功回调。
		expect(preBridge.pageHide).toHaveBeenCalledTimes(1)
	})
})
