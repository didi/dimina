import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { createAppConfigResponse } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'

// 守护测试（guard test）：锁定"销毁后的实例不再触碰逻辑线程、且不产生
// unhandled rejection"这条契约。曾经这条契约是靠一个偶然屏障成立的——被销毁
// 实例的续体会在 createBridge → await bridge.init()（pageFrame iframe 握手）处
// 永久挂起，根本到不了 jscore.postMessage，不是显式的"已销毁则提前返回"守卫。
// 现在已经换成显式机制：MiniApp.destroy() 会 abort 一个 AbortController，
// frameLoaded(signal) 据此 reject（而不是永远挂起），Bridge.createWebview()
// 把这个 reject 收敛成 resolve(null)，initApp() 在 await createBridge() 之后
// 检查 this._destroyed 提前返回——见 miniApp.ts destroy()/_destroyAbortController、
// bridge.ts createWebview()、webview.ts frameLoaded()。
//
// 场景：小程序 A 打开后，它的 app-config.json 请求还没回来（在途），容器就以
// destroy:true 打开了 B（销毁 A）。A 的 Worker 此时应该已经被 terminate。
// 等 A 的资源请求终于回来、A 在途的 initApp 恢复执行时：
//  (a) 不能产生任何 unhandled rejection / TypeError（比如对已销毁对象继续操作）；
//  (b) A 的 Worker 被 terminate 之后不应该再收到任何 postMessage
//      （用 vi.fn() 自带的 invocationCallOrder 判断"发生在 terminate 之后"，
//      不需要改动共享的 FakeWorker fixture）。
//
// fetch mock 自己实现（而不是复用 fixtures/mock-fetch.js 的 installFetchMock）：
// 需要精确控制"只有 A 的配置请求可被手动 release"，appList.json 和 B 的配置请求
// 照常立即返回。为了逼出真实竞态窗口（而不是把"destroy"和"A 的配置恢复"错开成
// 互不相关的先后顺序），先等够容器内部惯常的 launch-screen 最短展示时长，再让
// release() 和 openApp(B, {destroy:true}) 在同一个 tick 里起跑。

function jsonResponse(payload: unknown) {
	const text = JSON.stringify(payload)
	return Promise.resolve({
		ok: true,
		status: 200,
		json: () => Promise.resolve(JSON.parse(text)),
		text: () => Promise.resolve(text),
	})
}

function installControllableFetchMock(delayedAppId: string) {
	let releaseDelayed: () => void
	const delayedGate = new Promise<void>((resolve) => {
		releaseDelayed = resolve
	})

	const fetchMock = vi.fn((input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input))

		if (url.includes('appList.json')) {
			return jsonResponse([])
		}

		if (url.includes(delayedAppId)) {
			// A 的配置请求先挂起，直到测试手动调用 release() 才 resolve。
			return delayedGate.then(() => jsonResponse(createAppConfigResponse()))
		}

		return jsonResponse(createAppConfigResponse())
	})

	globalThis.fetch = fetchMock as unknown as typeof fetch
	return { fetchMock, release: () => releaseDelayed() }
}

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

describe('destroying an app while its resource fetch is still pending', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('does not let the destroyed app\'s stalled init reach its already-terminated worker', async () => {
		const APP_A = 'wx-slow-fetch-a'
		const APP_B = 'wx-slow-fetch-b'
		const { release } = installControllableFetchMock(APP_A)

		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		try {
			const container = createContainer({ mount })

			// A 打开：present 完成（openApp resolve），但 A 的 initApp 卡在 app-config 请求上。
			const miniAppA = await container.openApp({ appId: APP_A, path: 'pages/index/index' })
			const workerA = await waitForNextWorker(0)

			// 先等够 launch-screen 最短展示时长（避免 Promise.all 被 sleep 卡住掩盖竞态），
			// 再让"放行 A 的 fetch"和"以 destroy:true 打开 B"在同一个 tick 里起跑，
			// 制造两条路径的真实竞态窗口，而不是把两者错开成先后顺序。
			await new Promise(resolve => setTimeout(resolve, 600))
			release()
			const miniAppB = await container.openApp({ appId: APP_B, path: 'pages/index/index', destroy: true })
			await waitForNextWorker(1)

			// flush 微任务 + 给内部的启动延迟留出真实时间。
			await new Promise(resolve => setTimeout(resolve, 700))
			await Promise.resolve()
			await Promise.resolve()

			// (a) 不允许出现任何 unhandled rejection。
			expect(unhandledRejections).toEqual([])

			// (b) A 的 Worker 被 terminate 之后不应该再收到任何 postMessage。
			const terminateCallOrder = workerA.terminate.mock.invocationCallOrder[0]
			const postMessageCallsAfterTerminate = workerA.postMessage.mock.invocationCallOrder
				.filter((order: number) => order > terminateCallOrder)
			expect(postMessageCallsAfterTerminate).toHaveLength(0)

			// B 应该完好可用，不受 A 的延迟恢复影响。
			expect(() => miniAppB.getApiNamespaces()).not.toThrow()

			// (c) A 在途的 initApp 续体确实被 _destroyAbortController 打断提前返回了，
			// 不是继续跑完整个初始化流程后才"碰巧"不出错：entryPageBridge 从未
			// push 进 navigator。
			expect(miniAppA._destroyed).toBe(true)
			expect(miniAppA.navigator.getStack()).toHaveLength(0)
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
		}
	}, 15000)
})
