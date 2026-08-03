import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：navigateTo() 在 await createBridge() 之前就调用 updateTargetPageColorStyle()，
// 把 this.color 和宿主状态栏配色切成目标页的配色。如果之后 createBridge() reject，
// catch 分支只触发 onFail，没有把配色改回当前页原本的样子——用户会在一次失败的跳转
// 之后，看到状态栏样式停留在一个从未真正跳转成功的目标页配色上。
//
// 期望：createBridge() 对新目标页 reject 时，onFail 触发，且最终落定的 this.color、
// 以及最后一次推给宿主 shell 的颜色，都必须是跳转前当前页的原始配色，不能是被拒绝的
// 目标页配色。

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

describe('a failed navigateTo does not leave the chrome switched to the rejected target color', () => {
	it('restores this.color and the shell status-bar color to the original page after createBridge() rejects', async () => {
		const app = createApp()
		app.navigator.pushPage(createBridge('pages/first'))

		const updateStatusBarColor = vi.fn()
		app.parent = {
			updateStatusBarColor,
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => app),
		} as unknown as MiniApp['parent']

		app.createBridge = vi.fn().mockRejectedValue(new Error('bridge failed for pages/second'))

		await app.navigateTo({ url: '/pages/second', success: 'success-id', fail: 'fail-id', complete: 'complete-id' })

		expect(callbackIds(app)).toEqual(['fail-id', 'complete-id'])

		// crux：目标页配色（'white'）不应该是最终落定的颜色。
		expect(app.color).toBe('black')
		expect(updateStatusBarColor).toHaveBeenLastCalledWith('black')
	})
})
