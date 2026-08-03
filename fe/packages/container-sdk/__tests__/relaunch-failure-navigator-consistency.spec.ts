import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { interceptNextWebviewIframe } from './fixtures/iframe-hooks.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 守护测试：MiniApp.reLaunch() 在创建新入口页 bridge 之前，会先*同步*销毁
// 当前栈 + tab 池里的全部旧 bridge（bridge.destroy() + el.remove()），并同步
// 调用 this.navigator.clear() 让记账立刻收敛成空栈，再异步
// await this.createBridge(...) 创建新入口页——见 miniApp.ts reLaunch() 里
// "销毁所有现有的 bridge" 那段注释。这条不变量保证：不管随后异步的新 bridge
// 创建成功（.then() 里 pushPage 挂载新页）还是 reject（.catch() 只需要重置
// webviewAnimaEnd 并触发 onFail/onComplete，navigator 早已在同步阶段清空，
// 无需在失败分支里补清理），navigator 永远不会持有一批已经 destroy()、
// DOM 节点已摘除的僵尸 bridge 引用。
//
// 用 fixtures/iframe-hooks.js 的 interceptNextWebviewIframe 复现一次真实的
// （非 abort 的）渲染层握手失败：给 reLaunch() 内部新建的 webview iframe 锁定
// 一个不可写的 undefined DiminaRenderBridge，让 webview.init() 在
// frameLoaded() resolve 之后对 `iframeWindow.DiminaRenderBridge.invoke = ...`
// 抛出真实的 TypeError，从而让 Bridge.createWebview() reject（而不是走
// AbortError 分支被吞掉）——手法与 webview-init-real-error-not-swallowed.spec.ts
// 完全一致。
//
// 断言：reLaunch() 失败后，navigator 收敛成一个诚实的空栈
// （size === 0 / top === undefined / getPageStack() === []），不残留任何
// 已销毁旧 bridge 的引用。

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

interface PostedMessage { type: string, body?: { id?: unknown, args?: { errMsg?: string } } }

function findTriggerCallback(worker: InstanceType<typeof FakeWorker>, id: string): PostedMessage | undefined {
	const call = (worker.postMessage.mock.calls as [PostedMessage][]).find(
		([message]) => message?.type === 'triggerCallback' && message?.body?.id === id,
	)
	return call ? call[0] : undefined
}

async function waitForTriggerCallback(worker: InstanceType<typeof FakeWorker>, id: string, timeout = 8000): Promise<PostedMessage> {
	return vi.waitFor(() => {
		const message = findTriggerCallback(worker, id)
		if (!message) throw new Error(`triggerCallback with id "${id}" was not posted yet`)
		return message
	}, { timeout })
}

describe('reLaunch() leaves the navigator in a consistent state when the new entry bridge fails to init', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('fires reLaunch:fail and does not leave stale destroyed bridges behind in the navigator', async () => {
		const APP_ID = 'wx-relaunch-failure-navigator'

		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		try {
			const container = createContainer({ mount })
			const miniApp = await container.openApp({ appId: APP_ID, path: 'pages/index/index' })
			const worker = await waitForNextWorker(0)

			// 等入口页真正建好，保证 reLaunch() 要销毁的是一个"活" bridge。
			await vi.waitFor(() => {
				expect(miniApp.navigator.getStack()).toHaveLength(1)
			}, { timeout: 8000 })

			// 给 reLaunch() 内部即将创建的新入口页 webview 下套：锁定
			// DiminaRenderBridge 为不可写的 undefined，让它的握手真实失败
			// （不是 abort）。
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

			// reLaunch() 是同步函数（fire-and-forget），它内部对 createBridge()
			// 的调用会同步跑到 appendChild 这一步（Promise executor 同步执行），
			// 所以调用一返回，拦截就已经生效过了，可以立即 restore。
			miniApp.reLaunch({
				url: '/pages/index/index',
				success: 'relaunch-success',
				fail: 'relaunch-fail',
				complete: 'relaunch-complete',
			})
			hook.restore()

			const failResult = await waitForTriggerCallback(worker, 'relaunch-fail')
			expect(failResult.body?.args?.errMsg).toMatch(/^reLaunch:fail /)
			expect(failResult.body?.args?.errMsg).not.toMatch(/AbortError/)

			await waitForTriggerCallback(worker, 'relaunch-complete')

			// success 不应该在失败路径上被触发。
			expect(findTriggerCallback(worker, 'relaunch-success')).toBeUndefined()

			// 真实渲染层握手失败不应该被静默吞掉。
			expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('AbortError'))

			// crux：navigator 不能继续持有已经 destroy() 且 DOM 已摘除的旧
			// bridge 引用——失败后页面栈应该诚实地收敛成空。
			expect(miniApp.navigator.size).toBe(0)
			expect(miniApp.navigator.top).toBeUndefined()
			expect(miniApp.navigator.getStack()).toEqual([])
			expect(miniApp.navigator.getPageStack()).toEqual([])
			expect(miniApp.getPageStack()).toEqual([])
		}
		finally {
			consoleErrorSpy.mockRestore()
		}
	}, 15000)
})
