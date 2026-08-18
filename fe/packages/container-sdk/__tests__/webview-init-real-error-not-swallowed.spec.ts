import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { interceptNextWebviewIframe } from './fixtures/iframe-hooks.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 守护测试：Bridge.createWebview() 的 catch 分支必须能区分"destroy() 打断"和
// "渲染层 iframe 真的没装上 DiminaRenderBridge"这两类失败——见 bridge.ts
// createWebview() 上方的注释："非 abort 的真实初始化失败...必须照常 reject，
// 不能跟 abort 混为一谈被吞掉"。
//
// 这里完全不涉及 destroy：单纯让 iframe 正常 load，但渲染层没有正确安装
// DiminaRenderBridge 全局桥接对象（用 fixtures/iframe-hooks.js 在 iframe
// 被挂进 DOM 的*同一个同步调用栈*里，抢在 setup.js 全局 fixture 的
// queueMicrotask 之前，把 contentWindow.DiminaRenderBridge 锁定为不可写的
// undefined）。webview.ts 的 init() 在 frameLoaded() resolve 之后会做
// `iframeWindow.DiminaRenderBridge.invoke = ...`，缺桥接对象时这里必然
// 抛出真实的 TypeError——这条错误应该能被观察到（变成 rejection 或者被
// console.error 记录下来），不能像 AbortError 一样被静默吞掉。
//
// 抓的回归：如果有人把 Bridge.createWebview() 的 catch 分支改成无差别地
// `resolve(null)`（不再区分 AbortError 和其它错误），这个测试应该失败——
// 届时 initApp() 会"成功"完成，entryPageBridge 会被塞进 navigator，
// console.error 也不会被调用，与真实情况（渲染层初始化失败）严重不符。

describe('a real webview init failure (missing DiminaRenderBridge) is not swallowed as if it were a destroy-abort', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('surfaces the error via console.error and does not silently complete initApp', async () => {
		const APP_ID = 'wx-broken-render-bridge'

		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		try {
			const hook = interceptNextWebviewIframe((iframe: HTMLIFrameElement) => {
				const win = iframe.contentWindow
				if (win) {
					// 渲染层"没有正确安装" DiminaRenderBridge：锁定成不可写的
					// undefined，让 setup.js 全局 fixture 稍后尝试补桩的赋值
					// 静默失败（它自己包了 try/catch），最终 DiminaRenderBridge
					// 保持缺失状态。iframe 本身仍然会正常触发 load。
					Object.defineProperty(win, 'DiminaRenderBridge', {
						value: undefined,
						writable: false,
						configurable: false,
					})
				}
			})

			const container = createContainer({ mount })
			const miniApp = await container.openApp({ appId: APP_ID, path: 'pages/index/index' })
			hook.restore()

			// initApp() 是 fire-and-forget（viewDidLoad 里 .catch(console.error)），
			// 等它有机会跑完并把错误落到 console.error。
			await vi.waitFor(() => {
				expect(consoleErrorSpy).toHaveBeenCalled()
			}, { timeout: 8000 })

			// (a) 错误必须是可观察的：console.error 被调用，且第二个参数是一个
			// 真实的 Error/TypeError，不是 AbortError，也不是空字符串占位。
			const [, loggedError] = consoleErrorSpy.mock.calls[0]
			expect(loggedError).toBeInstanceOf(Error)
			expect((loggedError as Error).name).not.toBe('AbortError')

			// (b) 不允许把这类真实错误升级成 unhandled rejection——它应该被
			// viewDidLoad() 的 .catch() 接住,而不是到处乱窜。
			expect(unhandledRejections).toEqual([])

			// (c) 真实失败不能被静默吞掉、假装初始化成功：entryPageBridge 不应该
			// 被塞进 navigator。initApp() 的 catch 分支现在统一复用 destroy() 做
			// 完整收尾（见 initapp-failure-jscore-theme-teardown.spec.ts）——不管
			// 触发原因是并发 destroy() 打断还是这里的真实渲染层初始化失败，这个
			// 实例都已经不可能再恢复成有效状态，_destroyed 因此真实地变为 true，
			// 不再区分"是不是 destroy() 打断的路径"。
			expect(miniApp.navigator.getStack()).toHaveLength(0)
			expect(miniApp._destroyed).toBe(true)

			// (d) 逻辑线程 Worker 也随 destroy() 一起终止——这个实例整体已经失败，
			// 不应该留下一个仍然活着、却再也不会被任何页面用到的 Worker。
			await vi.waitFor(() => {
				expect(FakeWorker.instances.length).toBeGreaterThan(0)
			}, { timeout: 8000 })
			expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
			consoleErrorSpy.mockRestore()
		}
	}, 15000)
})
