import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：setStorage/getStorage/removeStorage/clearStorage/getStorageInfo 这 5 个方法
// 目前无条件读写 window.localStorage，key 按 `${appId}_${key}` 命名空间隔离，且没有任何
// 关闭或接管的手段——跟 urlSync 此前遇到的问题同构（见 url-sync-adapter.spec.ts）。
//
// 这暴露两个问题：
// 1) 宿主页面自身也可能用到 window.localStorage，或想把小程序存储路由到别的介质
//    （IndexedDB、加密存储、远程同步……），目前完全没有关闭或接管的手段。
// 2) `${appId}_${key}` 只按 appId 区分：同一 appId 在同一宿主页面下被多个独立的
//    createContainer() 实例分别打开时，会写到完全相同的 localStorage key，互相覆盖——
//    这是本文件末尾一个测试要留证的既有缺陷（characterization test，非本次修复目标，
//    留作后续引入自定义命名空间/命名空间适配器的动机说明）。
//
// 修复方向：新增 storageSync?: boolean | StorageAdapter，缺省/true 走内置
// window.localStorage（向后兼容），false 完全关闭（5 个方法都不再触碰
// window.localStorage，且必须以 fail 收场，不能假装成功），传入自定义 StorageAdapter 时
// SDK 转调适配器而不是 window.localStorage。
//
// 注意：这 5 个方法的 success/fail/complete 不是"传真实函数、SDK 直接同步调用"——源码里
// createCallbackFunction() 把它们当成逻辑线程传入的不透明 callback id，经
// jscore.postMessage({ type: 'triggerCallback', body: { id, args } }) 原样带回，与
// request-not-builtin.spec.ts 里 invokeApi 的验证方式完全一致。这里同样用字符串 id + 检查
// FakeWorker.postMessage 的调用记录来断言 success/fail 是否被触发，而不是传 vi.fn() 期待
// SDK 直接调用它。

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

/** 断言给定 id 在短暂等待窗口内始终没有被 triggerCallback 过（没有异步信号可等"确实不会发生"，用短暂常规等待兜底）。 */
async function expectNeverTriggerCallback(workerIndexStart: number, id: string, settleMs = 100) {
	await new Promise(resolve => setTimeout(resolve, settleMs))
	expect(findTriggerCallback(workerIndexStart, id)).toBeUndefined()
}

/** 内存版 StorageAdapter 假实现：真的存取，方便顺带验证数据经适配器正确往返。 */
function createFakeStorageAdapter() {
	const store = new Map<string, string>()
	return {
		getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
		setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
		removeItem: vi.fn((key: string) => { store.delete(key) }),
		key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
		get length() { return store.size },
	}
}

describe('storageSync controls whether/how the container touches localStorage', () => {
	let mount: HTMLElement
	let setItemSpy: ReturnType<typeof vi.spyOn>
	let getItemSpy: ReturnType<typeof vi.spyOn>
	let removeItemSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
		// jsdom 的 Storage 是带命名属性 getter/setter 的 legacy platform object：
		// vi.spyOn(window.localStorage, 'setItem') 不会真正替换方法（验证过：spy 装上后
		// Object.getOwnPropertyDescriptor(window.localStorage, 'setItem') 仍是 undefined，
		// 调用完全绕过 spy），必须 spy 在 Storage.prototype 上才能真正拦到
		// window.localStorage.setItem/getItem/removeItem 的调用。
		setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
		getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
		removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
	})

	describe('default / storageSync: true is backward compatible with the built-in window.localStorage', () => {
		it('defaults (no storageSync passed) to window.localStorage and round-trips setStorage → getStorage', async () => {
			const container = createContainer({ mount })
			const workerIndexBefore = FakeWorker.instances.length
			const miniApp = await container.openApp({ appId: 'wx-storage-sync-default', path: 'pages/index/index' })
			await waitForWorker(workerIndexBefore)

			miniApp.invokeApi('setStorage', { key: 'token', data: { value: 'abc' }, success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
			await waitForTriggerCallback(workerIndexBefore, 'set-success')
			expect(setItemSpy).toHaveBeenCalledWith('wx-storage-sync-default_token', expect.any(String))

			miniApp.invokeApi('getStorage', { key: 'token', success: 'get-success', fail: 'get-fail', complete: 'get-complete' })
			const getResult = await waitForTriggerCallback(workerIndexBefore, 'get-success')
			expect(getResult.body.args?.data).toEqual({ value: 'abc' })
			expect(getItemSpy).toHaveBeenCalledWith('wx-storage-sync-default_token')
		}, 10000)

		it('storageSync: true behaves identically to the default (explicit opt-in)', async () => {
			const container = createContainer({ mount, storageSync: true } as Parameters<typeof createContainer>[0])
			const workerIndexBefore = FakeWorker.instances.length
			const miniApp = await container.openApp({ appId: 'wx-storage-sync-true', path: 'pages/index/index' })
			await waitForWorker(workerIndexBefore)

			miniApp.invokeApi('setStorage', { key: 'token', data: 'plain-value', success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
			await waitForTriggerCallback(workerIndexBefore, 'set-success')
			expect(setItemSpy).toHaveBeenCalledWith('wx-storage-sync-true_token', expect.any(String))

			miniApp.invokeApi('getStorage', { key: 'token', success: 'get-success', fail: 'get-fail', complete: 'get-complete' })
			const getResult = await waitForTriggerCallback(workerIndexBefore, 'get-success')
			expect(getResult.body.args?.data).toEqual('plain-value')
		}, 10000)
	})

	describe('storageSync: false disables built-in localStorage access for all 5 storage methods', () => {
		async function openDisabledApp(appId: string) {
			const container = createContainer({ mount, storageSync: false } as Parameters<typeof createContainer>[0])
			const workerIndexBefore = FakeWorker.instances.length
			const miniApp = await container.openApp({ appId, path: 'pages/index/index' })
			await waitForWorker(workerIndexBefore)
			return { miniApp, workerIndexBefore }
		}

		it('setStorage fails and never touches window.localStorage.setItem', async () => {
			const { miniApp, workerIndexBefore } = await openDisabledApp('wx-storage-sync-disabled-set')

			miniApp.invokeApi('setStorage', { key: 'token', data: 'v', success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
			const failResult = await waitForTriggerCallback(workerIndexBefore, 'set-fail')
			expect(failResult.body.args?.errMsg).toMatch(/^setStorage:fail /)
			await expectNeverTriggerCallback(workerIndexBefore, 'set-success')
			expect(setItemSpy).not.toHaveBeenCalled()
		}, 10000)

		it('getStorage fails and never touches window.localStorage.getItem', async () => {
			const { miniApp, workerIndexBefore } = await openDisabledApp('wx-storage-sync-disabled-get')

			miniApp.invokeApi('getStorage', { key: 'token', success: 'get-success', fail: 'get-fail', complete: 'get-complete' })
			const failResult = await waitForTriggerCallback(workerIndexBefore, 'get-fail')
			expect(failResult.body.args?.errMsg).toMatch(/^getStorage:fail /)
			await expectNeverTriggerCallback(workerIndexBefore, 'get-success')
			expect(getItemSpy).not.toHaveBeenCalled()
		}, 10000)

		it('removeStorage fails and never touches window.localStorage.removeItem', async () => {
			const { miniApp, workerIndexBefore } = await openDisabledApp('wx-storage-sync-disabled-remove')

			miniApp.invokeApi('removeStorage', { key: 'token', success: 'remove-success', fail: 'remove-fail', complete: 'remove-complete' })
			const failResult = await waitForTriggerCallback(workerIndexBefore, 'remove-fail')
			expect(failResult.body.args?.errMsg).toMatch(/^removeStorage:fail /)
			await expectNeverTriggerCallback(workerIndexBefore, 'remove-success')
			expect(removeItemSpy).not.toHaveBeenCalled()
		}, 10000)

		it('clearStorage fails and never touches window.localStorage', async () => {
			const { miniApp, workerIndexBefore } = await openDisabledApp('wx-storage-sync-disabled-clear')

			miniApp.invokeApi('clearStorage', { success: 'clear-success', fail: 'clear-fail', complete: 'clear-complete' })
			const failResult = await waitForTriggerCallback(workerIndexBefore, 'clear-fail')
			expect(failResult.body.args?.errMsg).toMatch(/^clearStorage:fail /)
			await expectNeverTriggerCallback(workerIndexBefore, 'clear-success')
			expect(setItemSpy).not.toHaveBeenCalled()
			expect(getItemSpy).not.toHaveBeenCalled()
			expect(removeItemSpy).not.toHaveBeenCalled()
		}, 10000)

		it('getStorageInfo fails and never touches window.localStorage', async () => {
			const { miniApp, workerIndexBefore } = await openDisabledApp('wx-storage-sync-disabled-info')

			miniApp.invokeApi('getStorageInfo', { success: 'info-success', fail: 'info-fail', complete: 'info-complete' })
			const failResult = await waitForTriggerCallback(workerIndexBefore, 'info-fail')
			expect(failResult.body.args?.errMsg).toMatch(/^getStorageInfo:fail /)
			await expectNeverTriggerCallback(workerIndexBefore, 'info-success')
			expect(getItemSpy).not.toHaveBeenCalled()
		}, 10000)
	})

	describe('a custom storageSync adapter receives the calls instead of the SDK touching window.localStorage directly', () => {
		it('setStorage calls the adapter\'s setItem, never window.localStorage.setItem', async () => {
			const adapter = createFakeStorageAdapter()
			const container = createContainer({ mount, storageSync: adapter } as Parameters<typeof createContainer>[0])
			const workerIndexBefore = FakeWorker.instances.length
			const miniApp = await container.openApp({ appId: 'wx-storage-sync-custom-set', path: 'pages/index/index' })
			await waitForWorker(workerIndexBefore)

			miniApp.invokeApi('setStorage', { key: 'token', data: 'custom-value', success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
			await waitForTriggerCallback(workerIndexBefore, 'set-success')

			expect(adapter.setItem).toHaveBeenCalledWith('wx-storage-sync-custom-set_token', expect.any(String))
			expect(setItemSpy).not.toHaveBeenCalled()
		}, 10000)

		it('getStorage calls the adapter\'s getItem and success receives the adapter-returned data, never window.localStorage.getItem', async () => {
			const adapter = createFakeStorageAdapter()
			const container = createContainer({ mount, storageSync: adapter } as Parameters<typeof createContainer>[0])
			const workerIndexBefore = FakeWorker.instances.length
			const miniApp = await container.openApp({ appId: 'wx-storage-sync-custom-get', path: 'pages/index/index' })
			await waitForWorker(workerIndexBefore)

			miniApp.invokeApi('setStorage', { key: 'token', data: { via: 'adapter' }, success: 'set-success', fail: 'set-fail', complete: 'set-complete' })
			await waitForTriggerCallback(workerIndexBefore, 'set-success')

			miniApp.invokeApi('getStorage', { key: 'token', success: 'get-success', fail: 'get-fail', complete: 'get-complete' })
			const getResult = await waitForTriggerCallback(workerIndexBefore, 'get-success')

			expect(adapter.getItem).toHaveBeenCalledWith('wx-storage-sync-custom-get_token')
			expect(getResult.body.args?.data).toEqual({ via: 'adapter' })
			expect(getItemSpy).not.toHaveBeenCalled()
		}, 10000)
	})

	// characterization test：留证既有缺陷，不是本次要修的行为——`storageSync` 需要支持
	// 自定义/带命名空间的适配器，正是因为这个碰撞在缺省实现下无法避免。
	it('characterizes an existing gap: two independent createContainer() instances opening the same appId write to the identical window.localStorage key', async () => {
		const mountA = document.createElement('div')
		const mountB = document.createElement('div')
		document.body.appendChild(mountA)
		document.body.appendChild(mountB)
		const containerA = createContainer({ mount: mountA })
		const containerB = createContainer({ mount: mountB })

		const workerIndexBeforeA = FakeWorker.instances.length
		const miniAppA = await containerA.openApp({ appId: 'wx-storage-collision', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeA)

		const workerIndexBeforeB = FakeWorker.instances.length
		const miniAppB = await containerB.openApp({ appId: 'wx-storage-collision', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeB)

		miniAppA.invokeApi('setStorage', { key: 'shared-key', data: 'from-A', success: 'a-success', fail: 'a-fail', complete: 'a-complete' })
		await waitForTriggerCallback(workerIndexBeforeA, 'a-success')

		miniAppB.invokeApi('setStorage', { key: 'shared-key', data: 'from-B', success: 'b-success', fail: 'b-fail', complete: 'b-complete' })
		await waitForTriggerCallback(workerIndexBeforeB, 'b-success')

		expect(setItemSpy).toHaveBeenCalledTimes(2)
		const keysUsed = setItemSpy.mock.calls.map((call: unknown[]) => call[0])
		expect(keysUsed[0]).toBe('wx-storage-collision_shared-key')
		expect(keysUsed[1]).toBe('wx-storage-collision_shared-key')
	}, 10000)
})
