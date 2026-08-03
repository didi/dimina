import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSCore } from '../src/core/jscore.js'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { interceptNextWebviewIframe } from './fixtures/iframe-hooks.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：initApp() 的 catch 分支按顺序做——销毁孤儿 bridge → navigator.clear() →
// safeSyncUrl() → console.error(...) + this.parent?.onAppLaunchError?.(error, {appId})
// → this.destroy() → await this.parent?.removeFailedView(this) → throw error。
//
// onAppLaunchError 是宿主传入的回调（CreateContainerOptions.onAppLaunchError）：它
// 抛错这件事完全在宿主控制范围内，不受这个实例约束。但 catch 分支里对它的调用
// 没有包一层 try/catch——一旦它抛错，这个异常会直接从 catch 分支里逃逸，抢在
// this.destroy() 之前中断整个 catch 分支的执行：this.jscore（这个实例自己持有的
// Worker）永远不会被终止，这个实例也永远不会从 AppManager 的登记表里摘除，
// _destroyed 永远停留在 false——一个已经确定启动失败、地址栏/呈现栈已经摘掉它的
// 实例，其运行时资源（Worker）和登记表条目却继续悬空存在。
//
// 期望：宿主自己的 onAppLaunchError 回调抛错，只应该是宿主自己那次通知失败，
// 不能连带打断这个实例后续必须完成的强制清理——JSCore Worker 终止 + AppManager
// 登记表摘除必须照常发生。
//
// 手法与 initapp-failure-jscore-theme-teardown.spec.ts / webview-init-real-error-not-swallowed.spec.ts
// 一致：真实 createContainer + 真实 webview/worker 握手，拦截第一个被挂到 DOM 上的
// webview iframe，锁定 DiminaRenderBridge 为不可写 undefined，让渲染层握手真实失败，
// 从而让 initApp() 走进 catch 分支（不是伪造/mock 出来的失败）。

describe('a throwing host onAppLaunchError callback does not block initApp()\'s mandatory failure cleanup', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('still terminates the JSCore Worker and removes the AppManager registry entry when onAppLaunchError throws', async () => {
		const APP_ID = 'wx-onapplauncherror-throws-teardown'
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const jscoreDestroySpy = vi.spyOn(JSCore.prototype, 'destroy')

		// 修复前，第二次（viewDidLoad 外层 catch 里的）onAppLaunchError 调用会在
		// .catch() handler 内部再抛一次，变成一次 unhandled rejection——挂上监听器
		// 吸收掉，避免把这个真实、预期内的次生效应变成测试进程崩溃；不对它做断言，
		// 它不是本测试要验证的 crux。
		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		const onAppLaunchError = vi.fn(() => {
			throw new Error('host callback exploded')
		})

		const hook = interceptNextWebviewIframe((iframe: HTMLIFrameElement) => {
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
			const miniApp = await container.openApp({ appId: APP_ID, path: ENTRY_PAGE_PATH })
			hook.restore()

			// 前提：这次失败确实真实发生了——onAppLaunchError 至少被调用过一次
			// （catch 分支内那第一次调用，正是它的抛出打断了后续清理）。
			await vi.waitFor(() => {
				expect(onAppLaunchError).toHaveBeenCalled()
			}, { timeout: 8000 })

			// crux 1：这个实例自己的 Worker 必须被终止，不能因为宿主回调抛错就悬空。
			expect(jscoreDestroySpy).toHaveBeenCalledTimes(1)
			expect(jscoreDestroySpy).toHaveBeenCalledWith()
			expect(FakeWorker.instances.length).toBeGreaterThan(0)
			expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)

			// crux 2：_destroyed 必须真实置位——不能让一个已经确定启动失败的实例
			// 看起来仍然"活着"。
			expect(miniApp._destroyed).toBe(true)

			// crux 3：AppManager 登记表必须摘除这个失败的实例，不能让下一次针对
			// 同一 appId 的 openApp() 复用一个从未真正呈现成功的僵尸实例。
			expect(container.application.appManager.getAppById(APP_ID)).toBeNull()
		}
		finally {
			hook.restore()
			consoleErrorSpy.mockRestore()
			process.off('unhandledRejection', onUnhandledRejection)
		}
	}, 15000)
})
