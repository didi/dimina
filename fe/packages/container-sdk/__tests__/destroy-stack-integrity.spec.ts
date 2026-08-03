import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：destroy:true 打开新小程序时，必须完整、干净地销毁栈里其它的实例。
//
// 抓的 bug：
//  (a) "遍历中删除元素导致跳过"——依次打开 A、B、C 后再以 destroy:true 打开 D，
//      如果销毁逻辑是边遍历应用栈边从同一个数组里删除元素，中间的 B 很容易被跳过、
//      残留在栈里。
//  (b) 被销毁的小程序对应的逻辑线程 Worker 没有被 terminate，逻辑线程泄漏。
//  (c) 销毁后旧视图没有被摘出导航栈，后续关闭/操作可能碰到已销毁对象。
//
// application.views / application.getActiveView() 是契约里 `application`
// （"导航栈应用实例"）这个既有能力上的具体断言点。

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

function viewElements(application: { views: Array<{ el: HTMLElement } | HTMLElement> }) {
	return application.views.map(view => (view as MiniApp)?.el ?? view)
}

describe('destroy:true keeps the application stack and worker lifecycle intact', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('destroys every other app (including the middle one) and terminates their logic-thread workers', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-stack-a', path: 'pages/index/index' })
		const workerA = await waitForNextWorker(0)

		const miniAppB = await container.openApp({ appId: 'wx-stack-b', path: 'pages/index/index' })
		const workerB = await waitForNextWorker(1)

		const miniAppC = await container.openApp({ appId: 'wx-stack-c', path: 'pages/index/index' })
		const workerC = await waitForNextWorker(2)

		const miniAppD = await container.openApp({ appId: 'wx-stack-d', path: 'pages/index/index', destroy: true })
		const workerD = await waitForNextWorker(3)

		// (a) 应用栈只剩 D，A/B/C（尤其是中间的 B）都不应该残留。
		await vi.waitFor(() => {
			expect(container.application.views).toHaveLength(1)
		}, { timeout: 8000 })

		const remainingEls = viewElements(container.application)
		expect(remainingEls).not.toContain(miniAppA.el)
		expect(remainingEls).not.toContain(miniAppB.el)
		expect(remainingEls).not.toContain(miniAppC.el)
		expect(remainingEls).toContain(miniAppD.el)

		// (b) A/B/C 的逻辑线程 Worker 都要被 terminate；D 自己的 Worker 不应该被误杀。
		await vi.waitFor(() => {
			expect(workerA.terminate).toHaveBeenCalled()
			expect(workerB.terminate).toHaveBeenCalled()
			expect(workerC.terminate).toHaveBeenCalled()
		}, { timeout: 8000 })
		expect(workerD.terminate).not.toHaveBeenCalled()

		// (c) 已销毁的旧实例不应该还能通过 getActiveView 拿到，后续操作也不应该
		// 因为碰到残留的已销毁对象而抛错。
		const activeView = container.application.getActiveView()
		expect(activeView).not.toBe(miniAppA)
		expect(activeView).not.toBe(miniAppB)
		expect(activeView).not.toBe(miniAppC)
		expect(() => container.closeApp()).not.toThrow()
	}, 15000)
})
