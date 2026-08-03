import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { interceptNextWebviewIframe } from './fixtures/iframe-hooks.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：MiniApp.reLaunch() 在发起异步 createBridge() 之前，已经*同步*销毁了
// 旧栈 + tab 池里的全部 bridge，并同步调用 this.navigator.clear()（见
// relaunch-failure-navigator-consistency.spec.ts 对这条不变量的守护）。
//
// 成功路径里 miniApp.ts reLaunch() 的 .then() 分支会调用 this.parent?.syncUrl()，
// 让地址栏（Application.syncUrl() —— 唯一权威，见 url-sync-single-authority.spec.ts）
// 跟着新入口页刷新。但 .catch() 分支只触发 fail/complete 回调，从未调用
// this.parent?.syncUrl()。
//
// 后果：reLaunch() 失败之后，navigator 内部已经诚实地收敛成空栈，但地址栏
// （或自定义 urlSync 适配器）还停留在 reLaunch() 调用之前、旧的（现在已经被
// destroy() 摘除 DOM 的）页面上——对一个"按地址栏 query 在启动时自动
// openApp() 恢复状态"的宿主来说，这会诱导它在下一次刷新时把一个此实例里已经
// 不存在的页面重新打开。
//
// 用自定义 urlSync 适配器断言：reLaunch() 失败之后，urlSync 必须再收到一次
// 调用（syncStack 带上已经清空的页面栈，或直接 clear()），而不是停在失败前
// 那一次、仍然指向旧页面的调用上。

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

describe('reLaunch() re-syncs the address bar even when the new entry bridge fails to init', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('calls the urlSync adapter again to clear the destroyed old page after a failed reLaunch', async () => {
		const APP_ID = 'wx-relaunch-failure-url-sync'
		const syncStack = vi.fn()
		const clear = vi.fn()

		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		try {
			const container = createContainer({ mount, urlSync: { syncStack, clear } })
			const miniApp = await container.openApp({ appId: APP_ID, path: 'pages/index/index' })
			const worker = await waitForNextWorker(0)

			// 等入口页真正建好，且地址栏已经反映了它。
			await vi.waitFor(() => {
				expect(syncStack).toHaveBeenCalledWith(APP_ID, expect.any(Array))
			}, { timeout: 8000 })
			const callsBeforeReLaunch = syncStack.mock.calls.length + clear.mock.calls.length

			// 给 reLaunch() 内部即将创建的新入口页 webview 下套：锁定
			// DiminaRenderBridge 为不可写的 undefined，让它的握手真实失败（不是 abort）。
			// 手法与 relaunch-failure-navigator-consistency.spec.ts 完全一致。
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

			miniApp.reLaunch({
				url: '/pages/index/index',
				success: 'relaunch-success',
				fail: 'relaunch-fail',
				complete: 'relaunch-complete',
			})
			hook.restore()

			const failResult = await waitForTriggerCallback(worker, 'relaunch-fail')
			expect(failResult.body?.args?.errMsg).toMatch(/^reLaunch:fail /)
			await waitForTriggerCallback(worker, 'relaunch-complete')

			// 前提：navigator 确实已经收敛成空栈（销毁 + clear() 都是同步发生的）。
			expect(miniApp.navigator.getPageStack()).toEqual([])

			// crux：地址栏必须跟着这次失败重新同步一次，不能停在失败前、仍然
			// 指向旧（已销毁）页面的那一次调用上。
			expect(syncStack.mock.calls.length + clear.mock.calls.length).toBeGreaterThan(callsBeforeReLaunch)

			// 如果确实补发了同步，它反映的必须是清空后的状态：要么 clear()，
			// 要么 syncStack() 带一个空页面栈——不能仍然是失败前那个非空栈。
			const lastSyncStackCall = syncStack.mock.calls.at(-1)
			const resyncedToEmpty = clear.mock.calls.length > 0
				|| (lastSyncStackCall && Array.isArray(lastSyncStackCall[1]) && lastSyncStackCall[1].length === 0)
			expect(resyncedToEmpty).toBe(true)
		}
		finally {
			consoleErrorSpy.mockRestore()
		}
	}, 15000)
})
