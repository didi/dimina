import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bridge } from '../src/core/bridge.js'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：restore-failure-rollback.spec.ts 已经证明了一个 mid-restore initApp() 失败
// 会让 AppManager.getAppById() 收敛为 null、navigator 收敛为空栈。但那份收敛并不完整：
//
//   initApp() 的 catch 分支只调用了 this.parent?.appManager?.removeApp(this)，
//   从来没有把 this 从 Application.views（展示栈）里摘除。这个失败的 MiniApp
//   实例在 AppManager 眼里已经"不存在"了，但在 Application.views 里依然是
//   "当前呈现在最前的那个"——两处对同一个事实的记账各自为政、互相矛盾。
//
//   catch 分支的 this.navigator.clear() 只是清空 Navigator 内部的数组/Map，
//   从来没有对已经真实创建成功的 bridge（入口页、以及 restorePageStack 里已经
//   成功恢复的中间页）调用 .destroy()——这些 bridge 的资源（worker 消息监听、
//   iframe 握手状态）被静默泄漏，不是"未引用"而是"从未被要求释放"。
//
//   catch 分支收尾时若 isPresentedTop() 为真会调用 this.parent?.syncUrl()，
//   这一步经 Application.syncUrl() 落到宿主传入的 urlSync 适配器。如果这个
//   适配器本身抛错（例如宿主的地址栏同步逻辑有 bug），这个新错误会替换掉
//   `throw error`——原始的启动失败原因永远到不了 onAppLaunchError，宿主看到的
//   是一个跟真实故障无关的、被掩盖后的错误。
//
// 用与 restore-failure-rollback.spec.ts 相同的手法：真实 createContainer + 真实
// webview/worker 握手，拦截第 3 个被挂到 DOM 上的 webview iframe（对应 restoreStack
// 第三页，restorePageStack 循环里的第 2 次 createBridge()），只破坏它的渲染层握手，
// 让入口页与 restoreStack 第二页真实恢复成功、第三页真实失败。

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

describe('a mid-restore initApp() failure fully unwinds: view-stack membership, bridge destruction, and undistorted host error reporting', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('drops the failed instance from Application.views, destroys the bridges that were already created, and still reports the original failure to onAppLaunchError even though the urlSync cleanup call throws', async () => {
		const APP_ID = 'wx-restore-mid-failure-full-teardown'
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const onAppLaunchError = vi.fn()
		const destroySpy = vi.spyOn(Bridge.prototype, 'destroy')

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

		// urlSync 只需要在“失败清理阶段的那一次调用”抛错。这次 mid-restore 失败
		// （page 3 的渲染层握手在 ~LAUNCH_SCREEN_MIN_MS 处被破坏）比 presentView()
		// 自己的呈现动画（额外多等 2 帧 rAF 才开始同样时长的 waitTransitionEnd 兜底
		// 计时器）更快触底：initApp() 的 catch 分支会先调用一次 syncUrl()，
		// presentView() 收尾时才会调用它自己那次、与本测试无关的 syncUrl()。
		// 因此只让 urlSync 在被调用的第一次抛错，就精确对应失败清理阶段那一次，
		// 不会误伤 presentView() 随后那次正常调用（否则 openApp() 本身会 reject，
		// 测试就拿不到 miniApp 引用了）。
		let callCount = 0
		const urlSync = {
			syncStack: vi.fn(() => {
				callCount += 1
				if (callCount === 1) {
					throw new Error('urlSync.syncStack adapter blew up during cleanup')
				}
			}),
			clear: vi.fn(() => {
				callCount += 1
				if (callCount === 1) {
					throw new Error('urlSync.clear adapter blew up during cleanup')
				}
			}),
		}

		try {
			const container = createContainer({ mount, onAppLaunchError, urlSync })

			const restoreStack = [
				{ pagePath: ENTRY_PAGE_PATH, query: {} },
				{ pagePath: 'pages/second/second', query: {} },
				{ pagePath: 'pages/third/third', query: {} },
			]

			const miniApp = await container.openApp({ appId: APP_ID, path: ENTRY_PAGE_PATH, restoreStack })

			await vi.waitFor(() => {
				expect(onAppLaunchError).toHaveBeenCalled()
			}, { timeout: 8000 })

			// 基线（restore-failure-rollback.spec.ts 已覆盖，这里作为前提再断言一次）。
			expect(container.application.appManager.getAppById(APP_ID)).toBeNull()

			// crux：Application.views 不能继续持有这个已经失败、AppManager 里
			// 已经查不到的实例——两处记账必须收敛成同一个事实。
			expect(container.application.views).not.toContain(miniApp)

			// crux：失败前已经真实创建成功的 bridge（入口页 + restoreStack 第二页）
			// 必须被 destroy()，不能只是从 Navigator 的记账里消失就当作已经清理干净。
			expect(destroySpy.mock.calls.length).toBeGreaterThanOrEqual(2)

			// crux：即便 urlSync 清理阶段的适配器调用本身抛错，宿主收到的
			// 也必须是原始的启动失败错误，不能被这次清理阶段的新错误掩盖掉。
			expect(onAppLaunchError).toHaveBeenCalledTimes(1)
			const [error, meta] = onAppLaunchError.mock.calls[0] as [unknown, { appId: string }]
			expect(meta).toEqual({ appId: APP_ID })
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).not.toMatch(/urlSync\./)
			expect(consoleErrorSpy).toHaveBeenCalled()
		}
		finally {
			hook.restore()
			consoleErrorSpy.mockRestore()
		}
	}, 15000)
})
