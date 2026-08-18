import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// characterization test：storage 系列方法（setStorage/getStorage/clearStorage）用纯字符串
// 拼接 `${this.appId}_${key}` 生成底层存储 key，这个映射不是单射——appId 里如果含下划线，
// 两个不同的 (appId, key) 组合可以拼出完全相同的字符串：
//   appId="a_b", key="c"   → "a_b_c"
//   appId="a",   key="b_c" → "a_b_c"
// `OpenAppOptions.appId`（src/types.ts）是不受约束的纯 string，调用方完全可以选出这样的
// appId，两个互不相关的小程序会因此在底层 localStorage 里踩同一个槽位，后写的静默覆盖先写的。
//
// clearStorage() 用字符串前缀匹配 `key.startsWith(`${this.appId}_`)` 找待删除 key，前缀本身
// 有同样的歧义：appId="a" 产生的前缀 "a_" 恰好也是 appId="a_b" 产生的所有 key（形如
// "a_b_<key>"）的合法字符串前缀，于是清空 "a" 的存储会连带清空 "a_b" 的存储。
//
// 这是已知的、接受的限制，本次抽取不修复：`fe/packages/container`（这次抽取的来源）现在
// 主干上就是这个行为，Android/iOS 原生实现按 appId 分独立存储实例/文件（MMKV.mmkvWithID /
// DMPStorage.storage(for:)），key 用原始值不做拼接，天然没有这个碰撞——但那是原生平台的
// 存储模型，localStorage 是单个 origin 下的一个扁平 keyspace，没有"按 appId 建独立实例"
// 这个概念，无法照搬。要彻底消除碰撞需要换一种不兼容旧数据的 key 编码格式，会导致已经用
// 旧格式存过数据的用户升级后读不到旧数据（见 storage-legacy-key-migration 相关讨论）——
// 这个取舍对一次"原样抽取"的重构来说代价过高，因此保持与旧实现字节级一致的行为，把这个
// 边角碰撞留作已知限制，而不是趁抽取顺手修掉。
//
// 复用 storage-sync-adapter.spec.ts 里验证过的 house style：success/fail/complete 不是真函数，
// 是逻辑线程传入的不透明 callback id，SDK 经 jscore.postMessage({ type: 'triggerCallback', ... })
// 原样带回，这里同样用字符串 id + 检查 FakeWorker.postMessage 的调用记录来断言。

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

describe('storage key collisions across different appIds containing underscores (known, accepted limitation)', () => {
	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
	})

	it('two different appIds ("a_b" + key "c" vs "a" + key "b_c") clobber each other\'s setStorage data (later write wins)', async () => {
		const mountAB = document.createElement('div')
		const mountA = document.createElement('div')
		document.body.appendChild(mountAB)
		document.body.appendChild(mountA)

		const containerAB = createContainer({ mount: mountAB })
		const containerA = createContainer({ mount: mountA })

		const workerIndexBeforeAB = FakeWorker.instances.length
		const miniAppAB = await containerAB.openApp({ appId: 'a_b', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeAB)

		const workerIndexBeforeA = FakeWorker.instances.length
		const miniAppA = await containerA.openApp({ appId: 'a', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeA)

		// appId "a_b" 写 key "c"
		miniAppAB.invokeApi('setStorage', { key: 'c', data: 'value-from-a_b', success: 'ab-set-success', fail: 'ab-set-fail', complete: 'ab-set-complete' })
		await waitForTriggerCallback(workerIndexBeforeAB, 'ab-set-success')

		// appId "a" 写 key "b_c" —— 拼接后与上面撞成同一个底层 key "a_b_c"，静默覆盖
		miniAppA.invokeApi('setStorage', { key: 'b_c', data: 'value-from-a', success: 'a-set-success', fail: 'a-set-fail', complete: 'a-set-complete' })
		await waitForTriggerCallback(workerIndexBeforeA, 'a-set-success')

		miniAppAB.invokeApi('getStorage', { key: 'c', success: 'ab-get-success', fail: 'ab-get-fail', complete: 'ab-get-complete' })
		const abGetResult = await waitForTriggerCallback(workerIndexBeforeAB, 'ab-get-success')

		// 两边读到的都是后写入的 "value-from-a"——appId "a_b" 自己写的值被覆盖了
		expect(abGetResult.body.args?.data).toEqual('value-from-a')
	}, 10000)

	it('clearStorage on appId "a" also deletes keys belonging to appId "a_b" (prefix ambiguity)', async () => {
		const mountA = document.createElement('div')
		const mountAB = document.createElement('div')
		document.body.appendChild(mountA)
		document.body.appendChild(mountAB)

		const containerA = createContainer({ mount: mountA })
		const containerAB = createContainer({ mount: mountAB })

		const workerIndexBeforeA = FakeWorker.instances.length
		const miniAppA = await containerA.openApp({ appId: 'a', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeA)

		const workerIndexBeforeAB = FakeWorker.instances.length
		const miniAppAB = await containerAB.openApp({ appId: 'a_b', path: 'pages/index/index' })
		await waitForWorker(workerIndexBeforeAB)

		// appId "a_b" 写 key "x"，先确认它能正常往返
		miniAppAB.invokeApi('setStorage', { key: 'x', data: 'ab-value', success: 'ab-set-success', fail: 'ab-set-fail', complete: 'ab-set-complete' })
		await waitForTriggerCallback(workerIndexBeforeAB, 'ab-set-success')

		miniAppAB.invokeApi('getStorage', { key: 'x', success: 'ab-get-success-1', fail: 'ab-get-fail-1', complete: 'ab-get-complete-1' })
		const beforeClearResult = await waitForTriggerCallback(workerIndexBeforeAB, 'ab-get-success-1')
		expect(beforeClearResult.body.args?.data).toEqual('ab-value')

		// 清空 appId "a" 的存储 —— 前缀 "a_" 恰好也匹配 "a_b" 产生的 key，连带被清空
		miniAppA.invokeApi('clearStorage', { success: 'a-clear-success', fail: 'a-clear-fail', complete: 'a-clear-complete' })
		await waitForTriggerCallback(workerIndexBeforeA, 'a-clear-success')

		miniAppAB.invokeApi('getStorage', { key: 'x', success: 'ab-get-success-2', fail: 'ab-get-fail-2', complete: 'ab-get-complete-2' })
		const afterClearFail = await waitForTriggerCallback(workerIndexBeforeAB, 'ab-get-fail-2')

		expect(afterClearFail.body.args?.errMsg).toMatch(/^getStorage:fail /)
	}, 10000)
})
