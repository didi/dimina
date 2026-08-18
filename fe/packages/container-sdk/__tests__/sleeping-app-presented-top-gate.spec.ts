import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：Application.sleepActiveView() 把 isSleeping 置 true、对当前活跃 view 调用
// onPresentOut()，但不会把它从 this.views 里摘除——getActiveView() 在整个睡眠期间
// 仍然照常返回同一个 MiniApp。MiniApp 唯一的"是否呈现在最前"判据
// `isPresentedTop() = !this.parent || this.parent.getActiveView() === this`
// 完全没有检查 isSleeping：只要自己还是 views 栈顶，哪怕整个 Application 已经睡眠
// （例如宿主把容器整体切到后台），也会被判定为"呈现在最前"。
//
// 一次在途的异步导航（navigateTo/switchTab 里 await createBridge() 挂起）如果恰好
// 在 Application 睡眠期间 resolve，就会用这个错误判据把新 bridge 当成可见页启动、
// 把配色推给宿主 shell——而此刻整个小程序理应是后台/睡眠状态，不应该有任何可见性
// 或配色的变化。
//
// 期望：isSleeping 为 true 时，即使这个 MiniApp 仍然是 views 栈顶，也不能被判定为
// 呈现在最前——新 bridge 必须以 { visible: false } 启动。isSleeping 为 false 且仍是
// 栈顶时，行为保持现状（可见启动）——这是防止实现把判据写死成永远 false 的回归守卫。

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
	// 让真实的 updateTargetPageColorStyle()/updateActionColorStyle() 跑到底，
	// 这样才能真实断言配色是否被推给了 parent。
	const actionEl = { classList: { add: vi.fn(), remove: vi.fn() } }
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniApp
}

describe('a MiniApp must not be treated as presented-top while the whole Application is sleeping, even if it is still the top of views', () => {
	it('navigateTo: starts the new bridge non-visible and does not push color while isSleeping is true, though this MiniApp is still getActiveView()', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			// 仍然是 views 栈顶——旧判据会因此把它误判为呈现在最前。
			getActiveView: vi.fn(() => app),
			isSleeping: true,
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// crux：Application 处于睡眠状态时，新 bridge 不能被当成可见页启动。
		expect(newBridge.start).toHaveBeenCalledWith({ visible: false })
		// crux：睡眠状态下这次导航不应该把目标页配色推给宿主 shell。
		expect(fakeParent.updateStatusBarColor).not.toHaveBeenCalled()
	})

	it('switchTab: starts a newly-created target tab bridge non-visible and does not push color while isSleeping is true, though this MiniApp is still getActiveView()', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => app),
			isSleeping: true,
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const targetBridge = createBridge('pages/profile')
		app.createBridge = vi.fn().mockResolvedValue(targetBridge)

		await app.switchTab({ url: '/pages/profile', success: 's', fail: 'f', complete: 'c' })

		expect(targetBridge.start).toHaveBeenCalledWith({ visible: false })
		expect(fakeParent.updateStatusBarColor).not.toHaveBeenCalled()
	})

	it('regression guard: still starts the bridge visible and pushes color when isSleeping is false and this MiniApp is genuinely presented-top', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => app),
			isSleeping: false,
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// 回归守护：修复不能把可见性判断写死成永远 false——isSleeping: false 时
		// 仍然是栈顶就应该照常可见启动、照常推配色。
		expect(newBridge.start).not.toHaveBeenCalledWith({ visible: false })
		expect(fakeParent.updateStatusBarColor).toHaveBeenCalled()
	})
})
