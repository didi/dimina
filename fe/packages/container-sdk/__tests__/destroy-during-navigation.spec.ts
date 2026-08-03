import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { interceptNextWebviewIframe } from './fixtures/iframe-hooks.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 守护测试：MiniApp.navigateTo() 内部会 await createBridge() 创建新页面的 webview
// （渲染层 iframe 握手）。如果这个 webview 还没创建完成时，宿主就把整个小程序
// 销毁了（这里用 container.application.destroyRootView() 模拟"容器整体销毁当前
// MiniApp"这条触发路径，另一条 openApp({destroy:true}) 路径已由
// destroy-stack-integrity.spec.ts 覆盖），应该满足：
//  (a) 不产生 unhandled rejection；
//  (b) 已销毁小程序的 Worker 被 terminate 之后不再收到任何 postMessage；
//  (c) navigateTo 的 success/fail/complete 回调一次都不应该被触发（它们最终会
//      postMessage 到已经 terminate 的 Worker）；
//  (d) 已销毁小程序的 navigator 栈里不应该出现这个"半成品"的第二个页面——
//      这条依赖 miniApp.ts navigateTo() 里 `await this.createBridge()` 之后的
//      `if (this._destroyed) return` 守卫：没有这个守卫，continuation 会继续
//      往下跑，用 preBridge.webview（undefined）解引用抛错，或者把一个
//      webview:null 的半成品 bridge push 进 navigator。
//
// 用 fixtures/iframe-hooks.js 的 interceptNextWebviewIframe 拦住新 webview 的
// iframe.dispatchEvent，屏蔽掉 setup.js 全局 fixture 稍后派发的 'load' 事件，
// 从而把"webview 握手还没完成"这个窗口从一次性的微任务时序赌注，变成一个可以
// 稳定复现、直到测试主动放行为止的确定性状态。
//
// 这条测试守两类回归：
// 1. bridge.ts createWebview() 判定 abort 必须只看 `error.name === 'AbortError'`，
//    不能用 `error instanceof DOMException`——destroy() 触发
//    this._destroyAbortController.abort()（不带 reason）时，Node 内置
//    AbortController 用它自己 realm 的 DOMException 填充 signal.reason，
//    跨到 vitest+jsdom 环境下 globalThis.DOMException 不是同一个类，
//    instanceof 会判 false，把正常 abort 误判成"真实错误"抛出去。
// 2. navigateTo()/switchTab() 的 catch 块必须像 reLaunch() 一样，在调用
//    onFail 前先查 `this._destroyed`——否则 1 造成的伪错误被 catch 住后，
//    onFail 无条件调用，给已经 terminate 的 Worker postMessage 抛错，
//    使 navigateTo() 返回的 promise 直接 reject——invokeApi() 是
//    fire-and-forget 调用 navigateTo，这会变成真正的 unhandled rejection。

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

describe('destroying a MiniApp while navigateTo() has an in-flight webview creation', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('aborts the pending navigation cleanly and leaves no orphan page/DOM/callback behind', async () => {
		const APP_A = 'wx-nav-destroy-a'
		const SUCCESS_ID = 'nav-success-id'
		const FAIL_ID = 'nav-fail-id'
		const COMPLETE_ID = 'nav-complete-id'

		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		try {
			const container = createContainer({ mount })

			const miniAppA = await container.openApp({ appId: APP_A, path: 'pages/index/index' })
			const workerA = await waitForNextWorker(0)

			// 等入口页 bridge 真正建好（initApp 跑到 push entryPageBridge），
			// 保证接下来 navigateTo() 调用时 appConfig / navigator 已经就绪。
			await vi.waitFor(() => {
				expect(miniAppA.navigator.getStack()).toHaveLength(1)
			}, { timeout: 8000 })
			const entryBridge = miniAppA.navigator.getStack()[0]

			const hook = interceptNextWebviewIframe((iframe: HTMLIFrameElement) => {
				// 屏蔽这个 webview 的 load 事件：它的渲染层握手会永久悬而不决，
				// 直到 destroy 打断它（或者测试结束）。
				iframe.dispatchEvent = () => true
			})

			const navPromise = miniAppA.navigateTo({
				url: '/pages/detail/index',
				success: SUCCESS_ID,
				fail: FAIL_ID,
				complete: COMPLETE_ID,
			})

			// navigateTo() 应该已经同步跑到 createWebview() 里的 appendChild，
			// 新页面的半成品 webview 节点此刻已经挂进 DOM。
			await vi.waitFor(() => {
				expect(hook.getNode()).not.toBeNull()
			}, { timeout: 2000 })
			const orphanNode = hook.getNode() as unknown as HTMLElement
			hook.restore()

			// 容器整体销毁当前小程序（还卡在 navigateTo 的 webview 创建上）。
			await container.application.destroyRootView(miniAppA)

			// navigateTo() 的续体应该安静收敛（早退 resolve），不应该抛错或永久挂起。
			await expect(navPromise).resolves.toBeUndefined()

			// (a) 不允许出现任何 unhandled rejection。
			expect(unhandledRejections).toEqual([])

			expect(miniAppA._destroyed).toBe(true)

			// (b) Worker 被 terminate 之后不应该再收到任何 postMessage。
			await vi.waitFor(() => {
				expect(workerA.terminate).toHaveBeenCalled()
			}, { timeout: 2000 })
			const terminateCallOrder = workerA.terminate.mock.invocationCallOrder[0]
			const postMessageCallsAfterTerminate = workerA.postMessage.mock.invocationCallOrder
				.filter((order: number) => order > terminateCallOrder)
			expect(postMessageCallsAfterTerminate).toHaveLength(0)

			// (c) success/fail/complete 回调一次都不应该被触发。
			type PostedMessage = { type: string, body?: { id?: unknown } }
			const triggeredCallbackIds = (workerA.postMessage.mock.calls as [PostedMessage][])
				.map(([msg]) => msg)
				.filter((msg: PostedMessage) => msg.type === 'triggerCallback')
				.map((msg: PostedMessage) => msg.body?.id)
			expect(triggeredCallbackIds).not.toContain(SUCCESS_ID)
			expect(triggeredCallbackIds).not.toContain(FAIL_ID)
			expect(triggeredCallbackIds).not.toContain(COMPLETE_ID)

			// (d) 主栈不应该多出这个"半成品"的第二个页面：还是只有入口页那一个。
			expect(miniAppA.navigator.getStack()).toEqual([entryBridge])

			// (e) abort 时不留孤儿 DOM：这个半成品 webview 节点不应该残留在
			// 任何容器里（Bridge.createWebview 的 catch 分支应该已经把它 remove 掉）。
			expect(orphanNode.isConnected).toBe(false)
			expect(miniAppA.webviewsContainer?.contains(orphanNode)).toBe(false)

			// (f) 已销毁的实例不应该还留在导航栈里。
			expect(container.application.views).not.toContain(miniAppA)
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
		}
	}, 15000)
})
