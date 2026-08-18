import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：switchTab() 对未缓存的目标 tab，顺序是：
//   1. await createBridge() 创建目标 bridge（此时尚未登记进 tab 池，也未 start）
//   2. updateTargetPageColorStyle(targetMergeConfig) —— 这一步最终会走到
//      this.parent!.updateStatusBarColor(color!)，一个宿主提供的函数，可能抛错
//   3. 只有走到这里才 this.navigator.setTabBridge(...) 登记进池，并 targetBridge.start(...)
// 如果第 2 步抛错，第 3 步永远不会执行——刚创建成功的 bridge 既不在 Navigator 的 tab
// 池里，也从未 start()，变成一个孤儿：它已经真实创建（占用了资源、可能已经把自己的
// webview iframe 挂到了 DOM 上），却没有任何记账登记它的存在，之后也不会有人管它。
//
// 期望：已经创建成功的目标 bridge 必须被登记进 tab 池（Navigator.getTabBridge 能取到它）
// 且已经 start() 过——不能因为紧随其后的一次配色失败就让它变成未登记、未启动的孤儿。
// updateActionColorStyle() 内部对 this.parent!.updateStatusBarColor() 的调用现在统一
// 吞掉异常（宿主配色回调是不可信旁路，不能冒充"这次切换本身失败了"），所以配色回调
// 抛错不再让 switchTab 报 onFail——真正的切换工作（bridge 登记/start）本来就没受影响，
// 因此这次调用应该以 onSuccess 收场。

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

function createApp(tabPaths: string[]): MiniApp {
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.appConfig = {
		app: {},
		modules: {
			'pages/home': {},
			'pages/profile': {},
		},
	}
	app.appId = 'test-app'
	app.appInfo = { scene: 1001, appId: 'test-app', pagePath: 'pages/home', query: {} }
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app.color = 'black'
	app._isTabBarPage = vi.fn((path?: string | null) => tabPaths.includes((path ?? '').replace(/^\/+/, '')))
	app._setTabBarVisible = vi.fn()
	app._updateTabBarSelection = vi.fn()
	app._setBridgeTabBarInset = vi.fn()
	app._syncHash = vi.fn()
	// 不 stub updateTargetPageColorStyle/updateActionColorStyle：这次要的正是它们
	// 真实跑到 this.parent!.updateStatusBarColor(color!) 这一步并抛错。
	const actionEl = { classList: { add: vi.fn(), remove: vi.fn() } }
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniApp
}

function callbackIds(app: MiniApp): unknown[] {
	const postMessage = app.jscore.postMessage as unknown as ReturnType<typeof vi.fn>
	return postMessage.mock.calls.map(([message]) => (message as { body: { id: unknown } }).body.id)
}

describe('switchTab() must not orphan a freshly-created target tab bridge when the post-create color push fails', () => {
	it('still pools and starts the new target tab bridge even though updateStatusBarColor threw right after it was created', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		// 宿主 shell 的配色回调抛错——模拟例如状态栏原生桥接失败之类的真实故障。
		const fakeParent = {
			getActiveView: vi.fn(() => app),
			updateStatusBarColor: vi.fn(() => {
				throw new Error('host shell status bar bridge exploded')
			}),
			syncUrl: vi.fn(),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const targetBridge = createBridge('pages/profile')
		app.createBridge = vi.fn().mockResolvedValue(targetBridge)

		await app.switchTab({ url: '/pages/profile', success: 's', fail: 'f', complete: 'c' })

		// 配色回调抛错被 updateActionColorStyle() 吞掉，不冒充切换失败：switchTab
		// 的真实提交工作（bridge 登记/start）没受影响，应该以 onSuccess 收场。
		expect(callbackIds(app)).toEqual(['s', 'c'])
		expect(app.webviewAnimaEnd).toBe(true)

		// crux：即使配色推送失败，已经真实创建成功的 bridge 也不能是孤儿——必须
		// 登记进 tab 池，且必须已经 start() 过。
		expect(app.navigator.getTabBridge('pages/profile')).toBe(targetBridge)
		expect(targetBridge.start).toHaveBeenCalled()
	})
})
