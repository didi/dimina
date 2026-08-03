import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 守护测试：MiniApp.navigateBack() 内部会 `await waitTransitionEnd(preBridge.webview.el,
// 'transform')`——等上一页的 CSS transition 结束才继续，触发 success/fail/complete 回调。
// jsdom 不会真的播放 CSS transition、也不会派发 transitionend 事件，waitTransitionEnd
// 只能靠内部的 WAIT_TRANSITION_TIMEOUT_MS（见 src/constants/animation.ts，
// = PRESENT_TRANSITION_MS + 20 = 560ms）兜底超时来 resolve（见 miniApp.ts 顶部
// waitTransitionEnd 的实现：addEventListener('transitionend', ...) 之外还有一个
// setTimeout(resolve, timeout)）。
//
// 只要在这个 560ms 窗口内、在 navigateBack() 还没从这个 await 恢复执行时，宿主就把
// 整个小程序销毁掉（这里用 container.application.destroyRootView() 模拟，同
// destroy-during-navigation.spec.ts 覆盖 navigateTo() 的那条路径），就稳定复现了
// "后退动画还没播完、并发销毁整个小程序"这个场景。
//
// 观察到的关键实现事实（读 miniApp.ts navigateBack()，不影响本测试怎么写，只是
// 记录下来防止以后误解）：navigateBack() 的 try/catch/finally 里调用 onSuccess/
// onFail/onComplete 之前，不像 navigateTo() 那样查 `this._destroyed`——也就是说
// destroy() 发生后，navigateBack() 的续体依然会在 560ms 后正常跑完并调用这三个
// 回调。能让这条契约仍然成立的，是更底层的 JSCore.postMessage()（src/core/jscore.ts）：
// 它在真正 `this.worker.postMessage(msg)` 之前判空 `this.worker`——destroy() 会
// `terminate()` 之后把 `this.worker` 置 null，所以这些"迟到"的回调即使被调用，
// 也只是安静地被这道判空吸收掉，不会真的碰到已经 terminate 的 Worker。
//
// 这条测试要验证的就是这道判空是否还在生效：
//  (a) 不应该出现任何 unhandled rejection；
//  (b) 已销毁小程序的 Worker 被 terminate 之后不应该再收到任何 postMessage；
//  (c) navigateBack 传入的 success/fail/complete 回调 id，不应该出现在 Worker 收到
//      过的任何 triggerCallback 消息里；
//  (d) 小程序应该干净地完成销毁，不残留在导航栈里。

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

describe('destroying a MiniApp while navigateBack() is still awaiting its transition', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('never lets navigateBack callbacks reach the already-terminated worker', async () => {
		const APP_A = 'wx-navback-destroy-a'
		const SUCCESS_ID = 'navback-success-id'
		const FAIL_ID = 'navback-fail-id'
		const COMPLETE_ID = 'navback-complete-id'

		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		try {
			const container = createContainer({ mount })

			const miniAppA = await container.openApp({ appId: APP_A, path: 'pages/index/index' })
			const workerA = await waitForNextWorker(0)

			// 等入口页 bridge 真正建好，保证 navigateTo/navigateBack 用到的
			// appConfig / navigator 已经就绪。
			await vi.waitFor(() => {
				expect(miniAppA.navigator.getStack()).toHaveLength(1)
			}, { timeout: 8000 })

			// 打开第二个页面，navigateBack 才有上一页可退。这里不拦截 webview
			// 握手，让它按正常流程（含它自己的 560ms transition 兜底）走完。
			await expect(miniAppA.navigateTo({
				url: '/pages/detail/index',
				success: 'setup-nav-success-id',
				fail: 'setup-nav-fail-id',
				complete: 'setup-nav-complete-id',
			})).resolves.toBeUndefined()

			await vi.waitFor(() => {
				expect(miniAppA.navigator.getStack()).toHaveLength(2)
			}, { timeout: 8000 })

			// navigateBack() 同步跑到 `await waitTransitionEnd(...)` 就让出控制权，
			// 这个 await 之前的全部同步逻辑（pop/push navigator、pageShow、_syncHash
			// 等）已经跑完。紧接着（不 await 任何东西）就把整个小程序销毁掉，
			// 保证销毁发生在 560ms 兜底超时触发之前，也就是 transition 确实"还没结束"
			// 的窗口内。
			const navBackPromise = miniAppA.navigateBack({
				success: SUCCESS_ID,
				fail: FAIL_ID,
				complete: COMPLETE_ID,
			})

			await container.application.destroyRootView(miniAppA)

			// navigateBack() 的续体应该安静收敛（正常 resolve 或至少不 reject/挂起），
			// 不应该抛错或永久挂起。
			await expect(navBackPromise).resolves.toBeUndefined()

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

			// (c) navigateBack 的 success/fail/complete 回调 id，不应该出现在这个
			// Worker 收到过的任何 triggerCallback 消息里（无论是不是发生在 terminate
			// 之前——一旦 worker 已经判空吸收，这个 id 就不该在 postMessage 记录里
			// 留下任何痕迹）。
			type PostedMessage = { type: string, body?: { id?: unknown } }
			const triggeredCallbackIds = (workerA.postMessage.mock.calls as [PostedMessage][])
				.map(([msg]) => msg)
				.filter((msg: PostedMessage) => msg.type === 'triggerCallback')
				.map((msg: PostedMessage) => msg.body?.id)
			expect(triggeredCallbackIds).not.toContain(SUCCESS_ID)
			expect(triggeredCallbackIds).not.toContain(FAIL_ID)
			expect(triggeredCallbackIds).not.toContain(COMPLETE_ID)

			// (d) 小程序应该干净地完成销毁：不残留在导航栈里。
			expect(container.application.views).not.toContain(miniAppA)
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
		}
	}, 15000)
})
