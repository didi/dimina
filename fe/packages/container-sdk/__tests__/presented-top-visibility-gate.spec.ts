import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：Application.getActiveView() 返回展示栈栈顶（this.views.at(-1) || rootView）；一个
// MiniApp 是否"呈现在最前"由 `miniApp.parent.getActiveView() === miniApp` 唯一判定。
// Bridge.start(options) 不传 visible（或传 undefined）时，对一个全新 bridge 缺省为可见。
// 当前 navigateTo/switchTab（以及 redirectTo/navigateBack/initApp 自己的入口 bridge）
// 在 await createBridge() 之后无条件调用 bridge.start()/bridge.start({visible: 与后台
// 状态无关的值})，且 updateActionColorStyle() 无条件调用 this.parent.updateStatusBarColor()。
// 一个已经被别的小程序 present 到上面、自己沦为后台实例的 MiniApp 在这些方法执行期间
// 完全没有被挡住。
//
// 期望：MiniApp 不再是 parent.getActiveView() 时，resolve 出来的新 bridge 必须以
// { visible: false } 启动，且这次导航不应该把配色推给宿主 shell。仍然是
// presented-top 时，行为保持现状（可见启动 + 推送配色）。

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

function createApp(tabPaths: string[] = []): MiniApp {
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.appConfig = {
		app: {},
		modules: {
			'pages/first': {},
			'pages/second': {},
			'pages/home': {},
			'pages/profile': {},
		},
	}
	app.appInfo = { scene: 1001, pagePath: 'pages/first', query: {} }
	app.appId = 'test-app'
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app.color = null
	app._isTabBarPage = vi.fn((path?: string | null) => tabPaths.includes((path ?? '').replace(/^\/+/, '')))
	app._setTabBarVisible = vi.fn()
	app._updateTabBarSelection = vi.fn()
	app._setBridgeTabBarInset = vi.fn()
	app._syncHash = vi.fn()
	// 让真实的 updateTargetPageColorStyle()/updateActionColorStyle() 跑到底
	// （不 stub 掉），这样才能真实断言它是否把颜色推给了 parent。
	const actionEl = { classList: { add: vi.fn(), remove: vi.fn() } }
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniApp
}

describe('a backgrounded MiniApp must not surface a resolving bridge as visible or push its color to the shell', () => {
	it('navigateTo: keeps the new bridge non-visible and does not push the target color when no longer presented-top', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		const otherView = {}
		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => otherView),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// crux (a)：新 bridge 不能被当成可见页启动。
		expect(newBridge.start).toHaveBeenCalledWith({ visible: false })
		// crux (b)：这次导航不应该把目标页配色推给宿主 shell。
		expect(fakeParent.updateStatusBarColor).not.toHaveBeenCalled()
	})

	it('switchTab: keeps a newly-created target tab bridge non-visible and does not push its color when no longer presented-top', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		const otherView = {}
		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => otherView),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const targetBridge = createBridge('pages/profile')
		app.createBridge = vi.fn().mockResolvedValue(targetBridge)

		await app.switchTab({ url: '/pages/profile', success: 's', fail: 'f', complete: 'c' })

		expect(targetBridge.start).toHaveBeenCalledWith({ visible: false })
		expect(fakeParent.updateStatusBarColor).not.toHaveBeenCalled()
	})

	it('positive case: still starts the bridge visible and pushes the target color while genuinely presented-top', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => app),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// 回归守护：修复不能把可见性判断写死成永远 false。
		expect(newBridge.start).not.toHaveBeenCalledWith({ visible: false })
		expect(fakeParent.updateStatusBarColor).toHaveBeenCalled()
	})
})
