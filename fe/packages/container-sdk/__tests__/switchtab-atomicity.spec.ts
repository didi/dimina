import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：switchTab() 在确认目标 tab 的 bridge 真正就绪之前，不允许销毁/摘除任何现有页面
// 或 tab bridge。当前实现顺序相反：先同步销毁栈顶的非 tab 页（pageHide + destroy +
// DOM 移除）、隐藏并从主栈摘除旧 tab 的 bridge，再异步 await createBridge() 创建未缓存
// 的目标 tab；一旦这次 createBridge() reject，前面的销毁动作已经发生且没有任何回滚，
// Navigator 陷入一个既不是切换前、也不是切换后的半损坏状态（页面丢了、旧 tab 从栈里
// 消失，onFail 却只是简单地把错误丢给调用方）。
//
// 期望：createBridge() 对未缓存目标 tab reject 时，onFail 触发，且 Navigator.getStack()、
// 每个既有 tab 的 getTabBridge()、activeTabPath 必须与 switchTab() 调用前完全一致——
// 没有页面被销毁，没有 bridge 从栈或 tab 池里被摘除。

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
	// 桩造方式与 navigation-callbacks.spec.ts 一致：Object.create(MiniApp.prototype) +
	// Record<string, unknown> 自由赋值，最后统一 unknown 收窄回 MiniApp。
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.appConfig = {
		app: {},
		modules: {
			'pages/home': {},
			'pages/detail': {},
			'pages/profile': {},
		},
	}
	app.appId = 'test-app'
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app._isTabBarPage = vi.fn((path?: string | null) => tabPaths.includes((path ?? '').replace(/^\/+/, '')))
	app._setTabBarVisible = vi.fn()
	app._updateTabBarSelection = vi.fn()
	app._setBridgeTabBarInset = vi.fn()
	app._syncHash = vi.fn()
	app.updateTargetPageColorStyle = vi.fn()
	return app as unknown as MiniApp
}

function callbackIds(app: MiniApp): unknown[] {
	const postMessage = app.jscore.postMessage as unknown as ReturnType<typeof vi.fn>
	return postMessage.mock.calls.map(([message]) => (message as { body: { id: unknown } }).body.id)
}

describe('switchTab() must not destroy anything until the target tab bridge is confirmed ready', () => {
	it('does not destroy a non-tab page in front of the stack when the uncached target tab bridge rejects', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		const detailBridge = createBridge('pages/detail') // 非 tab 页，压在栈顶

		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')
		app.navigator.pushPage(detailBridge)

		app.createBridge = vi.fn().mockRejectedValue(new Error('bridge failed for pages/profile'))

		const stackBefore = app.navigator.getStack()
		const tabBridgeBefore = app.navigator.getTabBridge('pages/home')
		const activeTabBefore = app.navigator.activeTabPath

		await app.switchTab({ url: '/pages/profile', success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])
		expect(app.webviewAnimaEnd).toBe(true)

		// crux：非 tab 页不应该被销毁——它此刻仍然合法地在栈里。
		expect(detailBridge.destroy).not.toHaveBeenCalled()
		expect(detailBridge.pageHide).not.toHaveBeenCalled()
		expect(detailBridge.webview!.el.parentNode!.removeChild).not.toHaveBeenCalled()

		// crux：旧 tab 不应该被隐藏或从栈里摘除。
		expect(homeBridge.pageHide).not.toHaveBeenCalled()

		// Navigator 的记账必须与调用前逐字节一致。
		expect(app.navigator.getStack()).toEqual(stackBefore)
		expect(app.navigator.getTabBridge('pages/home')).toBe(tabBridgeBefore)
		expect(app.navigator.activeTabPath).toBe(activeTabBefore)
	})

	it('does not evict the previous tab bridge from the stack when the uncached target tab bridge rejects', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')

		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		app.createBridge = vi.fn().mockRejectedValue(new Error('bridge failed for pages/profile'))

		const stackBefore = app.navigator.getStack()

		await app.switchTab({ url: '/pages/profile', success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])
		expect(app.webviewAnimaEnd).toBe(true)

		// crux：当前 tab 的 bridge 不应该被隐藏、也不应该从主栈里被摘除。
		expect(homeBridge.pageHide).not.toHaveBeenCalled()
		expect(app.navigator.getStack()).toEqual(stackBefore)
		expect(app.navigator.getTabBridge('pages/home')).toBe(homeBridge)
		expect(app.navigator.activeTabPath).toBe('pages/home')
	})
})
