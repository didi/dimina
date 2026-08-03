import type { Bridge } from '../src/core/bridge.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：MiniApp.webviewAnimaEnd 是 navigateTo/redirectTo/navigateBack/switchTab/reLaunch
// 共享的忙锁——各自在方法开头检查并清空，方法结束时恢复为 true，已在途的调用会让后来者
// 立刻以 "xxx:fail busy" 失败退出，防止两个导航动作交叉修改同一个 Navigator 栈。
// initApp()/restorePageStack() 目前完全不碰这个标志：静默恢复阶段还有 createBridge()
// 挂在半空中时，一次并发的 navigateTo() 完全不会被这道锁挡住，会在 restore 还没收尾的
// navigator 上直接继续操作，栈顺序就此错乱。
//
// 期望：initApp() 的恢复阶段有一个 createBridge() 调用尚未 resolve 时，并发调用
// navigateTo() 必须像撞见另一个导航动作的动画期一样，立刻以 errMsg 含 "busy" 的 onFail
// 失败退出，不得触碰 Navigator。

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

function createBridgeStub(pagePath: string): Bridge {
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

describe('initApp()/restorePageStack() participate in the navigation busy-lock', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('fails a concurrent navigateTo() with a busy error while a restore-phase createBridge() call is still pending', async () => {
		const APP_ID = 'wx-startup-lock'

		const app = new MiniApp({
			appId: APP_ID,
			pagePath: 'pages/index/index',
			query: {},
			restoreStack: [
				{ pagePath: 'pages/index/index', query: {} },
				{ pagePath: 'pages/second/second', query: {} },
			],
		})
		mount.appendChild(app.el)

		const fakeParent = {
			updateStatusBarColor: vi.fn(),
			syncUrl: vi.fn(),
			getActiveView: vi.fn(() => app),
		}
		app.parent = fakeParent as unknown as MiniApp['parent']

		const entryBridge = createBridgeStub('pages/index/index')
		// 第二次 createBridge()（restorePageStack 里第一次被恢复的页面）故意永远不 resolve，
		// 模拟"恢复阶段有一个 bridge 创建仍在途"的真实状态。
		const secondBridgePromise = new Promise<Bridge>(() => {})

		const createBridgeMock = vi.fn()
		createBridgeMock.mockImplementationOnce(() => Promise.resolve(entryBridge))
		createBridgeMock.mockImplementationOnce(() => secondBridgePromise)
		app.createBridge = createBridgeMock as unknown as MiniApp['createBridge']

		// 与生产环境一致：viewDidLoad() 内部 fire-and-forget 调用 initApp()。
		app.viewDidLoad()

		const worker = await waitForNextWorker(0)

		await vi.waitFor(() => {
			expect(createBridgeMock.mock.calls.length).toBeGreaterThanOrEqual(2)
		}, { timeout: 8000 })

		// 此刻 restorePageStack() 正卡在第二次 createBridge() 的 await 上，尚未 resolve；
		// entry 页已经成功 push，navigator 只有 1 个元素。
		expect(app.navigator.getStack()).toHaveLength(1)

		await app.navigateTo({
			url: '/pages/should-not-run/should-not-run',
			success: 'nav-success',
			fail: 'nav-fail',
			complete: 'nav-complete',
		})

		const failMessage = findTriggerCallback(worker, 'nav-fail')
		expect(failMessage?.body?.args?.errMsg).toMatch(/busy/)
		expect(findTriggerCallback(worker, 'nav-success')).toBeUndefined()

		// crux：并发的 navigateTo() 不能碰到还在恢复中的 navigator。
		expect(app.navigator.getStack()).toHaveLength(1)
	}, 15000)
})
