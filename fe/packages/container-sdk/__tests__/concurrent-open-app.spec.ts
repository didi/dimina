import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：并发 openApp 必须安全。
//
// 不 await 第一次 openApp，立即发起第二次 openApp({destroy:true, 不同 appId})：
// 两个 Promise 都不能 reject；destroy 的清理逻辑不能因为撞上"第一个 app 还没建好"
// 就出错（比如对还没来得及 new 出来的 Worker 调 terminate、对 null/undefined
// 解引用），最终应用栈上只应该留下第二个 app。
describe('concurrent openApp calls are safe', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('resolves both openApp calls without rejecting and leaves only the second app alive', async () => {
		const container = createContainer({ mount })

		const firstPromise = container.openApp({ appId: 'wx-concurrent-a', path: 'pages/index/index' })
		const secondPromise = container.openApp({
			appId: 'wx-concurrent-b',
			path: 'pages/index/index',
			destroy: true,
		})

		const [miniAppA, miniAppB] = await Promise.all([firstPromise, secondPromise])

		expect(miniAppA).toBeTruthy()
		expect(miniAppB).toBeTruthy()

		await vi.waitFor(() => {
			expect(container.application.views).toHaveLength(1)
		}, { timeout: 8000 })

		const remainingView = container.application.views[0]
		expect(remainingView?.el ?? remainingView).toBe(miniAppB.el)
		expect(() => miniAppB.getApiNamespaces()).not.toThrow()
	}, 15000)
})
