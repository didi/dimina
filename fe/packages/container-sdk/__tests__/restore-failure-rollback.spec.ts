import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：MiniApp.initApp() 的静默恢复分支（刷新后带 restoreStack 重建多页）里，
// restorePageStack() 逐页 await createBridge() 并 pushPage()。若中间（非第一页）某一页
// 的 createBridge() reject，失败沿 initApp() 的 Promise 链一路冒泡，但此刻 navigator
// 已经持有前面几页恢复成功后留下的部分栈，AppManager 的登记表里这个实例也仍然原样
// 挂着——下一次针对同一 appId 的 openApp() 会复用这个半成品实例，而不是重新构建一个
// 干净的。
//
// 期望：initApp() 因恢复失败 reject 之后：
//   (a) AppManager.getAppById(appId) 必须收敛为 null，让后续 openApp() 重新构建全新实例；
//   (b) navigator 必须收敛成诚实的空栈，不留半成品页面；
//   (c) 既有的 onAppLaunchError 宿主回调仍然要触发（viewDidLoad() 的 initApp().catch() 分支）。
//
// 用真实的 createContainer + 真实 webview/worker 握手（setup.js 的 MutationObserver 桩），
// 用一个按"第 N 个被挂到 DOM 上的 webview iframe"计数的拦截器，只破坏第 3 个 iframe
// （对应 restoreStack 的第 3 页，即 restorePageStack 循环里的第 2 次 createBridge()），
// 让前两页真实恢复成功、第三页真实握手失败，复现"中间页失败"场景。

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

describe('a mid-restore failure during startup rolls back the AppManager registration and the navigator stack', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('removes the app from AppManager, collapses the navigator to an empty stack, and still reports onAppLaunchError', async () => {
		const APP_ID = 'wx-restore-mid-failure'
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const onAppLaunchError = vi.fn()

		// 第 1 个 iframe = 入口页（entry），第 2 个 = restoreStack 的第 2 页（成功恢复），
		// 第 3 个 = restoreStack 的第 3 页——真实破坏它的渲染层握手。
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

			// crux (a)：登记表必须收敛为 null，不能继续指向这个半成品实例。
			expect(container.application.appManager.getAppById(APP_ID)).toBeNull()

			// crux (b)：navigator 不能停在"入口页 + 第二页"这个半成品栈上。
			expect(miniApp.navigator.size).toBe(0)
			expect(miniApp.navigator.getStack()).toEqual([])
			expect(miniApp.navigator.getPageStack()).toEqual([])

			// (c)：既有回调仍然要触发，且带上真实的启动失败信息。
			const [error, meta] = onAppLaunchError.mock.calls[0] as [unknown, { appId: string }]
			expect(meta).toEqual({ appId: APP_ID })
			expect(error).toBeInstanceOf(Error)
			expect(consoleErrorSpy).toHaveBeenCalled()
		}
		finally {
			hook.restore()
			consoleErrorSpy.mockRestore()
		}
	}, 15000)
})
