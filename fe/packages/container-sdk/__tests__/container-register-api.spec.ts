import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 覆盖契约文档《ContainerInstance.registerApi 公开契约（v1）》的行为条目 1-7：
// createContainer() 返回值的容器级 API 注册 registerApi(name, handler)，与
// registerExtModule 的分发模型对称。

/** 等到指定起始下标之后出现下一个 FakeWorker 实例（对应某次 openApp 起的逻辑线程）。 */
async function waitForWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

/** 等到指定起始下标之后的某个 worker 收到匹配 id 的 triggerCallback 消息。 */
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

describe('createContainer().registerApi 容器级 API 注册', () => {
	let mount: HTMLElement
	let mountA: HTMLElement
	let mountB: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		mountA = document.createElement('div')
		mountB = document.createElement('div')
		document.body.appendChild(mount)
		document.body.appendChild(mountA)
		document.body.appendChild(mountB)
	})

	// 契约 1：对未来实例生效。
	it('registerApi 之后 openApp() 打开的小程序，wx.<name> 调用会派发到该 handler，this 绑定为该 miniApp 实例', async () => {
		const container = createContainer({ mount })
		let observedThis: unknown
		const handler = vi.fn(function (this: unknown, _params?: unknown) {
			observedThis = this
		})
		container.registerApi('qdFutureProbe', handler)

		const miniApp = await container.openApp({ appId: 'wx-register-future', path: 'pages/index/index' })
		miniApp.invokeApi('qdFutureProbe', { hello: 'world' })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ hello: 'world' }, undefined)
		expect(observedThis).toBe(miniApp)
	}, 10000)

	// 契约 2：对已存在实例生效。
	it('registerApi 对已经打开（openApp 已 resolve）的小程序同样生效，宿主无需逐实例再注册', async () => {
		const container = createContainer({ mount })
		const miniApp = await container.openApp({ appId: 'wx-register-existing', path: 'pages/index/index' })

		const handler = vi.fn()
		container.registerApi('qdExistingProbe', handler)
		miniApp.invokeApi('qdExistingProbe', { late: true })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ late: true }, undefined)
	}, 10000)

	// 契约 3：覆盖内置。同名（这里用内置 getNetworkType）时，容器级注册优先于内置实现。
	it('容器级注册名字与内置 API 相同（getNetworkType）时，容器级 handler 优先派发，内置实现不再执行', async () => {
		const container = createContainer({ mount })
		const handler = vi.fn()
		container.registerApi('getNetworkType', handler)

		const miniApp = await container.openApp({ appId: 'wx-register-override-builtin', path: 'pages/index/index' })
		const builtinSpy = vi.spyOn(miniApp, 'getNetworkType')

		miniApp.invokeApi('getNetworkType', { success: 'cb-id' })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(builtinSpy).not.toHaveBeenCalled()
	}, 10000)

	// 契约 4：实例级优先。宿主又调用了 miniApp.registerApi（后写）时，该实例上以实例级为准。
	it('实例级 miniApp.registerApi（后写）覆盖容器级注册，仅对该实例生效', async () => {
		const container = createContainer({ mount })
		const containerHandler = vi.fn()
		container.registerApi('qdPriorityProbe', containerHandler)

		const miniApp = await container.openApp({ appId: 'wx-register-priority', path: 'pages/index/index' })
		const instanceHandler = vi.fn()
		miniApp.registerApi('qdPriorityProbe', instanceHandler)

		miniApp.invokeApi('qdPriorityProbe', { source: 'instance' })

		expect(instanceHandler).toHaveBeenCalledTimes(1)
		expect(containerHandler).not.toHaveBeenCalled()
	}, 10000)

	// 契约 5：可枚举性。openApp 之前完成的容器级注册，名字要出现在该实例逻辑线程
	// worker 启动配置的 registeredApis 里（现有 Object.keys(wx) 枚举链路的容器侧出口）。
	it('openApp 之前完成的容器级注册，名字出现在该实例 worker 启动配置的 registeredApis 里', async () => {
		const container = createContainer({ mount })
		container.registerApi('qdEnumerableProbe', vi.fn())

		const workerIndexBefore = FakeWorker.instances.length
		await container.openApp({ appId: 'wx-register-enumerable', path: 'pages/index/index' })

		const worker = await waitForWorker(workerIndexBefore)
		const { registeredApis } = JSON.parse(worker.options.name)
		expect(registeredApis).toContain('qdEnumerableProbe')
	}, 10000)

	// 契约 6：多实例隔离。容器 A 的 registerApi 不影响容器 B。
	it('容器 A 的 registerApi 不影响容器 B：B 内调用同名 API 不会派发到 A 注册的 handler', async () => {
		const containerA = createContainer({ mount: mountA })
		const containerB = createContainer({ mount: mountB })

		const handlerA = vi.fn()
		containerA.registerApi('qdIsolationProbe', handlerA)
		await containerA.openApp({ appId: 'wx-register-isolation-a', path: 'pages/index/index' })

		const workerIndexBeforeB = FakeWorker.instances.length
		const miniAppB = await containerB.openApp({ appId: 'wx-register-isolation-b', path: 'pages/index/index' })

		miniAppB.invokeApi('qdIsolationProbe', {
			success: 'success-id',
			fail: 'fail-id',
			complete: 'complete-id',
		})

		// B 上没有这个 API（既不在 A 私有的容器级注册里，也不是内置方法），
		// 应该落到"不支持"分支而不是被 A 的 handler 处理。
		const failMessage = await waitForTriggerCallback(workerIndexBeforeB, 'fail-id')
		expect(failMessage.body.args.errMsg).toMatch(/not supported/i)
		expect(handlerA).not.toHaveBeenCalled()
	}, 10000)

	// 契约 7：重复注册同名。后注册的 handler 覆盖先注册的，对未来实例与已存在实例都以最新为准。
	it('重复调用 registerApi 用同一个 name：后注册的 handler 覆盖先注册的，未来实例与已存在实例都以最新为准', async () => {
		const container = createContainer({ mount })
		const h1 = vi.fn()
		const h2 = vi.fn()
		container.registerApi('qdDupProbe', h1)
		container.registerApi('qdDupProbe', h2) // 覆盖 h1，早于任何 openApp

		const miniApp = await container.openApp({ appId: 'wx-register-dup', path: 'pages/index/index' })
		miniApp.invokeApi('qdDupProbe', { round: 1 })

		expect(h2).toHaveBeenCalledWith({ round: 1 }, undefined)
		expect(h1).not.toHaveBeenCalled()

		const h3 = vi.fn()
		container.registerApi('qdDupProbe', h3) // 覆盖 h2，此时 miniApp 已经是"已存在实例"
		miniApp.invokeApi('qdDupProbe', { round: 2 })

		expect(h3).toHaveBeenCalledWith({ round: 2 }, undefined)
		expect(h2).toHaveBeenCalledTimes(1) // 仍然只有第一次那次调用，没有再被第二次派发命中
	}, 10000)
})
