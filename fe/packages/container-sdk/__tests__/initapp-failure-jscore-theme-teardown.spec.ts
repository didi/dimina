import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSCore } from '../src/core/jscore.js'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：initApp() 的 catch 分支（见 restore-failure-full-teardown.spec.ts 已覆盖的
// bridge/AppManager/Application.views 收敛）只处理了「已经创建成功的页面 bridge」，
// 从未调用 this.jscore.destroy()，也从未清理 _bindThemeChange() 装好的
// prefers-color-scheme 媒体查询监听器——这两项资源不属于任何一个 bridge，而是
// MiniApp 实例自己在 initApp() 一开始（早于任何可能失败的配置/bridge 步骤）就创建的：
//
//   await this.jscore.init()   // new Worker(...)
//   this._bindThemeChange()    // matchMedia(...).addEventListener('change', handler)
//
// 正常的 MiniApp.destroy() 方法会同时清理这两项（this.jscore.destroy() 终止 Worker，
// this._themeMediaQuery.removeEventListener(...) 摘掉监听器），但 initApp() 失败路径
// 从来没有调用 destroy()——只是手工摘除了 bridge 记账，两条清理路径各自为政，
// 失败路径漏了一半。
//
// 期望：一次失败的 initApp() 之后，这个 MiniApp 自己持有的 Worker 必须被终止，
// 媒体查询监听器必须被摘除——不能只清理它间接创建出的 bridge。
//
// 手法与 restore-failure-full-teardown.spec.ts 相同：真实 createContainer +
// 真实 webview/worker 握手，拦截第 3 个被挂到 DOM 上的 webview iframe（对应
// restoreStack 第三页），只破坏它的渲染层握手，让入口页与 restoreStack 第二页
// 真实恢复成功、第三页真实失败，initApp() 因此 reject。

function interceptNthWebviewIframe(n: number, onIntercept: (iframe: HTMLIFrameElement) => void) {
	const originalAppendChild = Element.prototype.appendChild
	let count = 0

	Element.prototype.appendChild = function (this: Element, ...args: Parameters<typeof originalAppendChild>) {
		const [child] = args
		const result = originalAppendChild.apply(this, args)
		if (child && typeof (child as Element).querySelector === 'function') {
			const found = (child as Element).querySelector('iframe')
			if (found) {
				count += 1
				if (count === n) {
					onIntercept(found as HTMLIFrameElement)
				}
			}
		}
		return result
	} as typeof Element.prototype.appendChild

	return {
		restore() {
			Element.prototype.appendChild = originalAppendChild
		},
	}
}

describe('a failed initApp() fully tears down the MiniApp instance\'s own resources, not just the page bridges it created', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('terminates the app-level JSCore Worker and removes the theme-change media-query listener after a mid-restore initApp() failure', async () => {
		const APP_ID = 'wx-initapp-failure-full-app-teardown'
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const onAppLaunchError = vi.fn()
		const jscoreDestroySpy = vi.spyOn(JSCore.prototype, 'destroy')

		// _bindThemeChange() 需要 globalThis.matchMedia 存在才会真的装监听器
		// （见 miniApp.ts: `if (!mediaQuery) return`）；jsdom 默认不实现它。
		// 手法与 theme-change.spec.ts 一致：喂一个可观测的假 MediaQueryList。
		const mediaQuery = {
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}
		const originalMatchMedia = globalThis.matchMedia
		globalThis.matchMedia = vi.fn(() => mediaQuery) as unknown as typeof globalThis.matchMedia

		// 第 1 个 iframe = 入口页（entry），第 2 个 = restoreStack 的第 2 页（成功恢复），
		// 第 3 个 = restoreStack 的第 3 页——真实破坏它的渲染层握手，触发 initApp() 失败。
		const hook = interceptNthWebviewIframe(3, (iframe) => {
			const win = iframe.contentWindow
			if (win) {
				Object.defineProperty(win, 'DiminaRenderBridge', {
					value: undefined,
					writable: false,
					configurable: false,
				})
			}
		})

		try {
			const container = createContainer({ mount, onAppLaunchError })

			const restoreStack = [
				{ pagePath: ENTRY_PAGE_PATH, query: {} },
				{ pagePath: 'pages/second/second', query: {} },
				{ pagePath: 'pages/third/third', query: {} },
			]

			const miniApp = await container.openApp({ appId: APP_ID, path: ENTRY_PAGE_PATH, restoreStack })

			await vi.waitFor(() => {
				expect(onAppLaunchError).toHaveBeenCalled()
			}, { timeout: 8000 })

			// 前提：这次失败确实真实发生（沿用姊妹测试已验证的基线）。
			expect(container.application.appManager.getAppById(APP_ID)).toBeNull()

			// crux 1：这个实例自己的 Worker（jscore）必须被终止，不能只清理 bridge。
			// 通过两个独立可观测信号交叉验证同一个事实：
			//   (a) JSCore.prototype.destroy 被调用过——MiniApp 真的驱动了清理动作；
			//   (b) 底层假 Worker 的 terminate() 真的被调用——不是空转的 destroy()。
			expect(jscoreDestroySpy).toHaveBeenCalledTimes(1)
			expect(jscoreDestroySpy).toHaveBeenCalledWith()
			// 这个 MiniApp 全程只创建过一个 Worker（jscore.init() 只调用一次）：
			// 直接断言它的 terminate() 被调用过，确认 destroy() 不是空转。
			expect(miniApp.appId).toBe(APP_ID)
			expect(FakeWorker.instances).toHaveLength(1)
			expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)

			// crux 2：_bindThemeChange() 装的媒体查询监听器必须被摘除，不能悬空监听
			// 一个已经失败、已经从 AppManager/Application.views 里摘除的实例。
			expect(mediaQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
			const themeHandler = mediaQuery.addEventListener.mock.calls[0][1]
			expect(mediaQuery.removeEventListener).toHaveBeenCalledWith('change', themeHandler)
		}
		finally {
			hook.restore()
			consoleErrorSpy.mockRestore()
			globalThis.matchMedia = originalMatchMedia
		}
	}, 15000)
})
