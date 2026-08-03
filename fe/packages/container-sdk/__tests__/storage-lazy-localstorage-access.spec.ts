import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：createContainer({ mount })（storageSync 缺省 true/不传）目前在 config.ts
// resolveStorageAdapter(true) 里立刻调用 wrapNativeStorage(window.localStorage)，也就是说
// 在容器创建阶段——不管这个小程序会不会调用任何 storage API——就会去访问一次
// window.localStorage。
//
// 在某些浏览器环境下（第三方 iframe、隐私模式等）访问 window.localStorage 这个 getter
// 本身就会同步抛 SecurityError（不是调用它的方法抛，是访问属性本身就抛）。这会导致
// createContainer() 直接同步抛错崩溃，而不是等到真正调用某个 storage API 时，才通过该
// API 自己的 fail 回调把错误报给调用方。
//
// 期望修复后的行为：window.localStorage access 本身会抛错时，createContainer({ mount })
// 和 container.openApp(...) 都必须能正常完成，不能抛出/reject（因为这里的小程序根本没
// 调用任何 storage API）；且这不是"从此以后 storage 永久坏掉"式的伪修复——localStorage
// 恢复正常后，setStorage/getStorage 必须能照常真实往返。
//
// 复用 storage-sync-adapter.spec.ts / storage-key-collision.spec.ts 的 house style：
// success/fail/complete 是逻辑线程传入的不透明 callback id，经
// jscore.postMessage({ type: 'triggerCallback', ... }) 原样带回。

/** 等到指定起始下标之后出现下一个 FakeWorker 实例（对应某次 openApp 起的逻辑线程）。 */
async function waitForWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

interface TriggerCallbackMessage {
	body: { id: string, args?: { data?: unknown, errMsg?: string, keys?: string[], currentSize?: number, limitSize?: number } }
}

function findTriggerCallback(workerIndexStart: number, id: string): TriggerCallbackMessage | undefined {
	const relevantWorkers = FakeWorker.instances.slice(workerIndexStart)
	for (const worker of relevantWorkers) {
		const call = worker.postMessage.mock.calls.find(
			([message]: [{ type?: string, body?: { id?: string } }]) => message?.type === 'triggerCallback' && message?.body?.id === id,
		)
		if (call) return call[0] as TriggerCallbackMessage
	}
	return undefined
}

/** 等到指定起始下标之后的某个 worker 收到匹配 id 的 triggerCallback 消息，返回其 payload。 */
async function waitForTriggerCallback(workerIndexStart: number, id: string, timeout = 8000): Promise<TriggerCallbackMessage> {
	return vi.waitFor(() => {
		const message = findTriggerCallback(workerIndexStart, id)
		if (!message) throw new Error(`triggerCallback with id "${id}" was not posted yet`)
		return message
	}, { timeout })
}

describe('createContainer does not eagerly access window.localStorage during construction', () => {
	let originalDescriptor: PropertyDescriptor | undefined

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
			?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'localStorage')
	})

	afterEach(() => {
		// 保证测试之间不会互相污染 window.localStorage——其它测试文件都依赖它是正常可用的。
		if (originalDescriptor) {
			Object.defineProperty(window, 'localStorage', originalDescriptor)
		}
	})

	/** 让访问 window.localStorage 这个 getter 本身同步抛 SecurityError（不是调用其方法抛）。 */
	function makeLocalStorageAccessThrow() {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new DOMException('The operation is insecure.', 'SecurityError')
			},
		})
	}

	it('createContainer({ mount }) and openApp(...) succeed even when accessing window.localStorage itself throws synchronously', async () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)

		makeLocalStorageAccessThrow()

		let container!: ReturnType<typeof createContainer>
		expect(() => {
			container = createContainer({ mount })
		}).not.toThrow()

		const workerIndexBefore = FakeWorker.instances.length
		const miniApp = await container.openApp({ appId: 'lazy-localstorage-app', path: 'pages/index/index' })
		await waitForWorker(workerIndexBefore)

		expect(miniApp.appId).toBe('lazy-localstorage-app')
		expect(miniApp.pagePath).toBe('pages/index/index')
	}, 10000)

	it('storage calls still round-trip normally once window.localStorage access is restored (the fix is deferred access, not a permanently broken/cached adapter)', async () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)

		makeLocalStorageAccessThrow()

		const container = createContainer({ mount })
		const workerIndexBefore = FakeWorker.instances.length
		const miniApp = await container.openApp({ appId: 'lazy-localstorage-recovery', path: 'pages/index/index' })
		await waitForWorker(workerIndexBefore)

		// 恢复真实的 window.localStorage access
		if (originalDescriptor) {
			Object.defineProperty(window, 'localStorage', originalDescriptor)
		}

		miniApp.invokeApi('setStorage', { key: 'k', data: 'recovered-value', success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
		await waitForTriggerCallback(workerIndexBefore, 'set-success')

		miniApp.invokeApi('getStorage', { key: 'k', success: 'get-success', fail: 'get-fail', complete: 'get-complete' })
		const getResult = await waitForTriggerCallback(workerIndexBefore, 'get-success')
		expect(getResult.body.args?.data).toEqual('recovered-value')
	}, 10000)
})
