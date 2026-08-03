import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：switchTab() 对未缓存的目标 tab，创建成功后立刻做两件事——
//   this.navigator.setTabBridge(targetPath, targetBridge)   // 登记进池，避免孤儿（已修）
//   targetBridge.start({ visible: this.isPresentedTop() })  // 开始加载资源
// 当 this.isPresentedTop() 为 true 时，第二步当场把 desiredPageVisible 设成 true——
// 这发生在旧页面被隐藏/销毁之前、目标 tab 被真正 push 进主栈/设为 activeTabPath 之前。
// 期望：start() 只负责"开始加载"，不负责"变为可见"——不管 isPresentedTop() 是否为
// true，未缓存目标 tab 的 start() 调用都必须传 { visible: false }，把"真正可见"的
// 责任留给切换真正提交之后才会调用的 pageShow()（switchTab() 收尾时已有的
// `if (this.isPresentedTop()) targetBridge.pageShow()` 那一步）。
//
// updateTargetPageColorStyle()（最终落到宿主提供的 this.parent!.updateStatusBarColor）
// 抛错的情形现在统一在 updateActionColorStyle() 源头被吞掉，不再冒充"切换本身失败了"，
// 因此即使配色回调抛错，switchTab() 仍然会以 onSuccess 收场、正常走完剩余的提交步骤
// （旧页面下线、目标 push 进主栈、pageShow()）——第一个用例验证的是 start() 在池化
// 那一刻传的可见性参数不受配色回调是否抛错影响，不是"配色失败会让切换整体失败"。

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
	const actionEl = { classList: { add: vi.fn(), remove: vi.fn() } }
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniApp
}

function callbackIds(app: MiniApp): unknown[] {
	const postMessage = app.jscore.postMessage as unknown as ReturnType<typeof vi.fn>
	return postMessage.mock.calls.map(([message]) => (message as { body: { id: unknown } }).body.id)
}

describe('switchTab() must not let a freshly-created target tab bridge become visible-and-live before the switch has actually committed', () => {
	it('starts the new target tab bridge with { visible: false } at the pooling step, even though isPresentedTop() is true and the color push also throws (now absorbed, so the switch still fully commits)', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		// 宿主 shell 的配色回调抛错——与 switchtab-orphaned-bridge-on-color-failure.spec.ts
		// 相同的故障注入，这里关注的是 start() 的可见性参数，而不是孤儿登记问题。
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

		// 配色回调抛错被 updateActionColorStyle() 吞掉，不冒充切换失败：真正的提交
		// 工作（旧页面下线、目标 push 进主栈、pageShow）照常完成。
		expect(callbackIds(app)).toEqual(['s', 'c'])

		// crux：目标 bridge 在池化那一刻，start() 传给它的 visible 必须是 false，
		// 不因为此刻 isPresentedTop() 为 true 就直接置为可见——"真正可见"的职责
		// 留给切换提交后才调用的 pageShow()。
		expect(targetBridge.start).toHaveBeenCalledTimes(1)
		expect(targetBridge.start).toHaveBeenCalledWith({ visible: false })
		// 切换真正提交，pageShow() 必须被调用。
		expect(targetBridge.pageShow).toHaveBeenCalledTimes(1)
	})

	it('still makes the target tab bridge actually visible via pageShow() once switchTab() fully commits and succeeds', async () => {
		const app = createApp(['pages/home', 'pages/profile'])
		const homeBridge = createBridge('pages/home')
		app.navigator.pushPage(homeBridge)
		app.navigator.setTabBridge('pages/home', homeBridge)
		app.navigator.setActiveTabPath('pages/home')

		const fakeParent = {
			getActiveView: vi.fn(() => app),
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const targetBridge = createBridge('pages/profile')
		app.createBridge = vi.fn().mockResolvedValue(targetBridge)

		await app.switchTab({ url: '/pages/profile', success: 's', fail: 'f', complete: 'c' })

		// 这次配色回调没有抛错，切换真正提交、成功。
		expect(callbackIds(app)).toEqual(['s', 'c'])

		// 防止实现者为了让第一个用例变绿，简单粗暴地永远传 { visible: false } 而
		// 从不让 tab 变为真正可见——切换成功提交后，pageShow() 必须被调用，
		// 承担起"现在才真正显现"的职责。
		expect(targetBridge.pageShow).toHaveBeenCalledTimes(1)
	})
})
