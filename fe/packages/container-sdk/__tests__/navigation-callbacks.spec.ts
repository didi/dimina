import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

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
	// 桩造一个 MiniApp：只填测试用到的字段，字段之间彼此不满足真实类型约束
	// （如 appConfig.app 缺 entryPagePath/pages），这里先按 Record<string, unknown>
	// 自由赋值，最后统一 unknown 收窄回 MiniApp，避免每个字段单独类型体操。
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.appConfig = {
		app: {},
		modules: {
			'pages/first': {},
			'pages/second': {},
		},
	}
	app.appInfo = { scene: 1001 }
	app.appId = 'test-app'
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app._isTabBarPage = vi.fn(() => false)
	app._setTabBarVisible = vi.fn()
	app._syncHash = vi.fn()
	app.updateTargetPageColorStyle = vi.fn()
	return app as unknown as MiniApp
}

function callbackIds(app: MiniApp): unknown[] {
	const postMessage = app.jscore.postMessage as unknown as ReturnType<typeof vi.fn>
	return postMessage.mock.calls.map(([message]) => (message as { body: { id: unknown } }).body.id)
}

describe('MiniApp navigation callbacks', () => {
	it('keeps custom tabBar inside the page without falling back to the host tabBar', () => {
		const app = createApp()
		const tabBarEl = { style: {} as CSSStyleDeclaration, textContent: 'host tabBar' }
		app.el = {
			querySelector: vi.fn(() => tabBarEl),
			style: { setProperty: vi.fn() },
		} as unknown as HTMLElement
		app.appConfig!.app.tabBar = {
			custom: true,
			list: [{ pagePath: 'pages/first', text: 'First' }],
		}
		app._renderTabBar = vi.fn()

		app._initTabBar()

		expect(app.customTabBar).toBe(true)
		expect(app.tabBarPaths).toEqual(['pages/first'])
		expect(tabBarEl.textContent).toBe('')
		expect(tabBarEl.style.display).toBe('none')
		expect(app.tabBarHeight).toBe(0)
		expect(app._renderTabBar).not.toHaveBeenCalled()
	})

	it('restores only the top page as visible', async () => {
		const app = createApp()
		const root = createBridge('pages/first')
		const middle = createBridge('pages/first')
		const top = createBridge('pages/second')
		app.navigator.pushPage(root)
		app.createBridge = vi.fn()
			.mockResolvedValueOnce(middle)
			.mockResolvedValueOnce(top)

		await app.restorePageStack([
			{ pagePath: 'pages/first', query: {} },
			{ pagePath: 'pages/second', query: {} },
		])

		expect(middle.start).toHaveBeenCalledWith({ visible: false })
		expect(top.start).toHaveBeenCalledWith({ visible: true })
	})

	it('resolves navigateBack with success and complete callbacks', async () => {
		const app = createApp()
		const previous = createBridge('pages/first')
		const current = createBridge('pages/second')
		app.navigator.pushPage(previous)
		app.navigator.pushPage(current)

		await app.navigateBack({ success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['success-id', 'complete-id'])
		expect(app.webviewAnimaEnd).toBe(true)
		expect(current.destroy).toHaveBeenCalledTimes(1)
		expect(previous.pageShow).toHaveBeenCalledTimes(1)
	})

	it('rejects navigateBack when there is no previous page', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		await app.navigateBack({ success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])
	})

	it('rejects navigation while another transition is active', async () => {
		const app = createApp()
		app.webviewAnimaEnd = false

		await app.navigateTo({ url: 'pages/second', success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])
	})

	it('restores the navigation lock when creating a page fails', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))
		app.createBridge = vi.fn().mockRejectedValue(new Error('bridge failed'))

		await app.navigateTo({ url: 'pages/second', success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])
		expect(app.webviewAnimaEnd).toBe(true)
	})
})
