import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：同一页面内多次 createContainer() 得到的容器实例必须完全隔离。
//
// 抓的 bug：SDK 内部残留模块级/静态全局状态（应用栈、扩展模块表），
// 导致第二个 createContainer() 出来的容器和第一个"串台"——同 appId 拿到同一个
// miniApp 缓存实例、A 注册的 ext 模块在 B 里也能查到、A 用 destroy:true 打开新
// 小程序时把 B 的栈也清空了。这些都是"用同一个模块级单例服务多个容器实例"的
// 典型症状，只有在同一个 spec 文件里连续 new 两个容器才能测出来（vitest 默认
// 按文件隔离模块上下文，同文件内的两次 createContainer() 调用共享同一份模块状态）。

async function waitForTriggerCallback(workerIndexStart: number, id: string, timeout = 8000) {
	return vi.waitFor(() => {
		const relevantWorkers = FakeWorker.instances.slice(workerIndexStart)
		for (const worker of relevantWorkers) {
			const call = worker.postMessage.mock.calls.find(
				([message]: [{ type?: string, body?: { id?: string } }]) => message?.type === 'triggerCallback' && message?.body?.id === id,
			)
			if (call) {
				return call[0]
			}
		}
		throw new Error(`triggerCallback with id "${id}" was not posted yet`)
	}, { timeout })
}

describe('multiple createContainer() instances are isolated', () => {
	let mountA: HTMLElement
	let mountB: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mountA = document.createElement('div')
		mountB = document.createElement('div')
		document.body.appendChild(mountA)
		document.body.appendChild(mountB)
	})

	it('gives each container its own miniApp instance and DOM subtree for the same appId', async () => {
		const containerA = createContainer({ mount: mountA })
		const containerB = createContainer({ mount: mountB })

		const miniAppA = await containerA.openApp({ appId: 'wx-shared-app-id', path: 'pages/index/index' })
		const miniAppB = await containerB.openApp({ appId: 'wx-shared-app-id', path: 'pages/index/index' })

		expect(miniAppA).not.toBe(miniAppB)
		expect(mountA.childElementCount).toBeGreaterThan(0)
		expect(mountB.childElementCount).toBeGreaterThan(0)
	}, 10000)

	it('does not expose a registerExtModule handler registered on container A to container B', async () => {
		const handlerA = vi.fn(({ success }: { success?: (result?: unknown) => void }) => success?.({ ok: true }))
		const containerA = createContainer({ mount: mountA })
		containerA.registerExtModule('IsolationTestModule', handlerA)
		await containerA.openApp({ appId: 'wx-ext-a', path: 'pages/index/index' })

		const workerIndexBeforeB = FakeWorker.instances.length
		const containerB = createContainer({ mount: mountB })
		const miniAppB = await containerB.openApp({ appId: 'wx-ext-b', path: 'pages/index/index' })

		miniAppB.invokeApi('ping', {
			module: 'IsolationTestModule',
			data: {},
			success: 'success-id',
			fail: 'fail-id',
			complete: 'complete-id',
		})

		const failMessage = await waitForTriggerCallback(workerIndexBeforeB, 'fail-id')
		expect(failMessage.body.args.errMsg).toMatch(/not registered/i)
		expect(handlerA).not.toHaveBeenCalled()
	}, 10000)

	it('does not let closing/destroying container A affect container B\'s stack', async () => {
		const containerA = createContainer({ mount: mountA })
		const containerB = createContainer({ mount: mountB })

		const miniAppB = await containerB.openApp({ appId: 'wx-close-iso-b', path: 'pages/index/index' })
		await containerA.openApp({ appId: 'wx-close-iso-a', path: 'pages/index/index' })

		expect(() => containerA.closeApp()).not.toThrow()
		expect(mountB.childElementCount).toBeGreaterThan(0)
		expect(() => miniAppB.getApiNamespaces()).not.toThrow()

		// destroy:true 会在容器内部销毁"其它 appId"的实例；如果应用栈是模块级共享的，
		// 这里在 A 上开一个新 appId 会把 B 的根视图也销毁掉——直接查 B 的根节点是否
		// 还挂在文档里，比只看 mountB 是否还有子节点更能抓住"跨容器错误 removeChild"
		// 这类异步/延迟发作的破坏（否则可能只在测试运行的其它角落冒出 unhandled
		// rejection，而这条用例本身却"侥幸"通过）。
		await containerA.openApp({ appId: 'wx-close-iso-a-2', path: 'pages/index/index', destroy: true })

		expect(mountB.childElementCount).toBeGreaterThan(0)
		expect(miniAppB.el.isConnected).toBe(true)
		expect(() => miniAppB.getApiNamespaces()).not.toThrow()
	}, 10000)
})
