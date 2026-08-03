import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 覆盖 createContainer({ apis, extModules }) 的原子注册契约（实现尚未落地，
// 本文件预期为红灯）：
//   - apis/extModules 必须在 createContainer() 构造阶段、早于任何 openApp() 就
//     完成注册，等价于"createContainer() 返回后立刻手动调用
//     container.registerApi(name, handler) / registerExtModule(name, handler)"。
//   - 即使调用方紧接着就 openApp()、不额外调用 .registerApi()，apis 里的名字
//     也必须已经生效，并且要出现在该次 openApp 打开的小程序 worker 启动配置的
//     registeredApis 里（可枚举性，对应 Object.keys(wx) 枚举链路的容器侧出口，
//     参见 container-register-api.spec.ts 契约 5 的同款验证手段）。
//   - 通过 apis 注册的 API 之后仍可被显式 container.registerApi(name, other)
//     覆盖，不破坏现有 registerApi 后写覆盖先写的语义。

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

/**
 * apis/extModules 是即将新增到 createContainer() 的可选字段，
 * CreateContainerOptions（src/types.ts）现在还没有声明它们。这里用一个宽松类型
 * 的本地包装绕开 TS 对 createContainer() 参数的多余属性检查，让本文件的红灯
 * 来自真实的运行时派发行为（字段目前会被 createContainer 忽略、API 派发不到
 * handler），而不是被一个到处乱窜的类型报错掩盖或误导——不修改 src 下任何类型
 * 声明。
 */
function createContainerWithPendingOptions(options: {
	mount: HTMLElement
	apis?: Record<string, (this: unknown, params?: unknown) => void>
	extModules?: Record<string, (payload: { event: string, data?: unknown, success?: (result?: unknown) => void, fail?: (error: { errMsg: string }) => void }) => (() => void) | void>
}) {
	return createContainer(options as unknown as Parameters<typeof createContainer>[0])
}

describe('createContainer({ apis, extModules }) 构造阶段原子注册', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	// 用例 1：不额外调用 registerApi，openApp() 打开的小程序直接能派发到 apis 里的 handler。
	it('createContainer({ apis }) 之后不额外 registerApi，openApp() 打开的小程序 invokeApi 能正确派发到该 handler', async () => {
		let observedThis: unknown
		const handler = vi.fn(function (this: unknown, _params?: unknown) {
			observedThis = this
		})

		const container = createContainerWithPendingOptions({
			mount,
			apis: { qdAtomicProbe: handler },
		})

		const miniApp = await container.openApp({ appId: 'wx-atomic-apis', path: 'pages/index/index' })
		miniApp.invokeApi('qdAtomicProbe', { hello: 'world' })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ hello: 'world' }, undefined)
		expect(observedThis).toBe(miniApp)
	}, 10000)

	// 用例 2：可枚举性——apis 里的名字必须早于 openApp 生效，出现在该次 openApp
	// 打开的小程序 worker 启动配置的 registeredApis 里，而不是延迟到某次调用才补上。
	it('createContainer({ apis }) 注册的名字出现在 openApp 打开的小程序 worker 启动配置的 registeredApis 里', async () => {
		const container = createContainerWithPendingOptions({
			mount,
			apis: { qdAtomicEnumerableProbe: vi.fn() },
		})

		const workerIndexBefore = FakeWorker.instances.length
		await container.openApp({ appId: 'wx-atomic-enumerable', path: 'pages/index/index' })

		const worker = await waitForWorker(workerIndexBefore)
		const { registeredApis } = JSON.parse(worker.options.name)
		expect(registeredApis).toContain('qdAtomicEnumerableProbe')
	}, 10000)

	// 用例 3：extModules 同理，小程序能通过 ext 调用路径正确触发该扩展模块，
	// 不需要调用方另外手动 registerExtModule。
	it('createContainer({ extModules }) 之后小程序能通过 ext 调用路径正确触发该扩展模块', async () => {
		const extHandler = vi.fn(({ data, success }: { data?: unknown, success?: (result?: unknown) => void }) => {
			success?.({ echo: data })
		})

		const container = createContainerWithPendingOptions({
			mount,
			extModules: { AtomicExtModule: extHandler },
		})

		const workerIndexBefore = FakeWorker.instances.length
		const miniApp = await container.openApp({ appId: 'wx-atomic-ext', path: 'pages/index/index' })

		miniApp.invokeApi('ping', {
			module: 'AtomicExtModule',
			data: { x: 1 },
			success: 'success-id',
			fail: 'fail-id',
			complete: 'complete-id',
		})

		const successMessage = await waitForTriggerCallback(workerIndexBefore, 'success-id')
		expect(extHandler).toHaveBeenCalledTimes(1)
		expect(extHandler.mock.calls[0][0]).toMatchObject({ event: 'ping', data: { x: 1 } })
		expect(successMessage.body.args).toEqual({ echo: { x: 1 } })
	}, 10000)

	// 用例 4：覆盖语义——apis 里注册的 handler 先生效，之后仍可被显式
	// container.registerApi() 覆盖，后写覆盖先写，不破坏现有 registerApi 契约
	// （container-register-api.spec.ts 契约 7）。先验证 handlerA 确实在生效
	// （这一步在实现落地前就会红，证明 apis 字段目前根本没被注册），再验证
	// registerApi(handlerB) 能把它覆盖掉。
	it('container.registerApi(name, handlerB) 覆盖 createContainer({ apis }) 里同名的 handlerA，后写覆盖先写', async () => {
		const handlerA = vi.fn()
		const handlerB = vi.fn()

		const container = createContainerWithPendingOptions({
			mount,
			apis: { qdAtomicOverrideProbe: handlerA },
		})

		const miniApp = await container.openApp({ appId: 'wx-atomic-override', path: 'pages/index/index' })
		miniApp.invokeApi('qdAtomicOverrideProbe', { round: 1 })

		expect(handlerA).toHaveBeenCalledTimes(1)
		expect(handlerA).toHaveBeenCalledWith({ round: 1 }, undefined)

		container.registerApi('qdAtomicOverrideProbe', handlerB) // 覆盖 handlerA
		miniApp.invokeApi('qdAtomicOverrideProbe', { round: 2 })

		expect(handlerB).toHaveBeenCalledTimes(1)
		expect(handlerB).toHaveBeenCalledWith({ round: 2 }, undefined)
		expect(handlerA).toHaveBeenCalledTimes(1) // 仍然只有覆盖之前那一次，没有再被第二次派发命中
	}, 10000)
})
