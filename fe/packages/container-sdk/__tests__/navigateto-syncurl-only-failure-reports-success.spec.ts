import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约：navigateTo() 的真实步骤顺序是：
//   1. await createBridge()                         —— 目标页 bridge 真实创建成功
//   2. updateTargetPageColorStyle(mergeConfig)       —— 配色真实提交
//   3. this.navigator.pushPage(bridge)               —— 目标页真实入栈，成为 Navigator 的新栈顶
//   4. bridge.start({ visible: this.isPresentedTop() })
//   5. this.parent?.syncUrl()                        —— 宿主提供的 urlSync.syncStack，可能抛错
//   6. （只有走到这里才）preBridge.pageHide() + 播放入场动画 + onSuccess
// 如果第 5 步的 syncUrl() 抛错，执行直接跳进 catch：第 6 步——旧页面被真正 pageHide()、
// 播放退场/入场动画——从未发生，但 catch 分支只回滚 this.color，随后调用 onFail。
// 此刻 Navigator 的真实状态已经是「新页面是栈顶」（第 3 步已经真实发生，catch 分支
// 从不 popPage() 撤销它），却对宿主报告 onFail——宿主看到的"跳转失败"与
// Navigator/bridge 的真实状态（新页面已经接管）互相矛盾：地址栏没跟上（这才是唯一
// 真正没完成的部分），但页面本身已经真实、完整地切换过去了。
//
// 期望：navigateTo 因为这类「仅地址栏同步适配器抛错」而进入 catch 分支时，最终必须
// 报告 onSuccess（因为页面切换本身——bridge 创建、push、动画——已经完整地跑完了，
// 只是一步 best-effort 的地址栏同步失败，不应该被混同为"导航失败"），且这次报告的
// onSuccess 必须对应一次真正完整的切换：Navigator 栈顶是新页面，旧页面必须已经被
// pageHide() 过——不能是一次报告成功、但实际只做了一半的切换。
//
// 张力提示（不修改、不消费该测试）：这与已有的
// navigateto-late-failure-color-rollback.spec.ts 对同一个触发场景（createBridge()
// 成功 resolve、syncUrl() 随后抛错）断言了矛盾的终态——那份测试期望 onFail + 配色
// 回滚到跳转前的原始值；这份测试期望 onSuccess + 配色维持在目标页、且完整地走完
// pageHide/动画收尾。两份测试对同一触发条件给出互斥的终态期望，是因为它们编码了
// 两种不同的语义立场（"syncUrl 失败=导航失败" vs. "syncUrl 失败≠导航失败，只是
// 地址栏没跟上"）。本次改动的立场是后者：一旦这个修复落地，
// navigateto-late-failure-color-rollback.spec.ts 里那条测试的前提就过时了，需要
// 由实现者显式修改/淘汰它（并说明修改原因），而不是无声地让两份测试同时假装通过。

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
			'pages/second': {},
		},
	}
	app.appInfo = { scene: 1001, pagePath: 'pages/first', query: {} }
	app.appId = 'test-app'
	app.navigator = new Navigator()
	app.jscore = { postMessage: vi.fn() }
	app.webviewAnimaEnd = true
	app.color = 'black'
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

describe('a navigateTo failure caused solely by the address-bar sync adapter throwing must not be reported as a failed navigation', () => {
	it('reports onSuccess (not onFail), and leaves Navigator/the previous page in a state consistent with a fully-completed transition, when only syncUrl() throws after the page transition itself already succeeded', async () => {
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

		// createBridge、配色提交、push、start 都真实发生——失败点仅仅是紧随其后的
		// syncUrl()，与页面切换本身是否成功完全无关。
		const newBridge = createBridge('pages/second')
		app.createBridge = vi.fn().mockResolvedValue(newBridge)

		await app.navigateTo({ url: '/pages/second', success: 's', fail: 'f', complete: 'c' })

		// crux 1：地址栏同步是 best-effort，不能被当成导航是否成功的判据——
		// 页面切换本身完整跑完了，必须报告 onSuccess，不是 onFail。
		expect(callbackIds(app)).toEqual(['s', 'c'])

		// crux 2：报告的 onSuccess 必须对应一次真正完整的切换：Navigator 的
		// 权威状态里，新页面确实是当前栈顶。
		expect(app.navigator.top).toBe(newBridge)

		// crux 3：既然报告的是成功，旧页面必须已经真正被 pageHide() 过——不能是一次
		// "半成品"切换被包装成成功回调,旧页面还留在前台生命周期里。
		expect(preBridge.pageHide).toHaveBeenCalledTimes(1)
	})
})
