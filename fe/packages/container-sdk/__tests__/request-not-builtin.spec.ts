import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 覆盖即将落地的契约：SDK 不再内置 wx.request 的实现（原实现硬编码了某个 demo
// 专属的本地代理地址 http://localhost:7788/proxy，不是通用实现，整个从 MiniApp 中删除）。
// 之后 request 与 scanCode 等其它 API 一样，完全交给宿主通过
// registerApi('request', handler) 注册；未注册时必须落到 invokeApi 的
// "不支持" 分支（_handleUnsupportedApi），既不能吞掉调用，也不能发起任何真实网络请求。
//
// 本文件写在实现删除之前：第一个用例现在应当是红灯（built-in request 仍存在，
// 会真的调用 fetch），这是预期状态，不要因为它失败就去"修"它。

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

describe('MiniApp.request 不再是内置实现', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	// 红灯用例：宿主未 registerApi('request', ...) 时，invokeApi('request', ...) 必须
	// 走 _handleUnsupportedApi（errMsg 精确对齐现有格式），且绝不能发起真实网络请求。
	it('未注册 request handler 时，invokeApi 不发起任何真实网络请求，且必须以 "api is not supported" 失败', async () => {
		const container = createContainer({ mount })
		const workerIndexBefore = FakeWorker.instances.length
		const miniApp = await container.openApp({ appId: 'wx-request-unsupported', path: 'pages/index/index' })
		await waitForWorker(workerIndexBefore)

		// openApp 引导阶段（读取 app-config.json 等）用的是 installFetchMock 装的 fetch；
		// 从这里开始换一个专属 spy，只关心 request 这次调用是否会打到网络。
		// 用 mockRejectedValue 而不是"永不 resolve"：万一红灯态下真的走到网络分支，
		// 也能让 promise 链快速走完 .catch，不留下悬空的未处理 rejection / 慢测试。
		const fetchSpy = vi.fn().mockRejectedValue(new Error('request 不应该在没有 registerApi 时真正发起网络请求'))
		globalThis.fetch = fetchSpy

		miniApp.invokeApi('request', {
			url: 'https://example.com',
			success: 'req-success-id',
			fail: 'req-fail-id',
			complete: 'req-complete-id',
		})

		// 契约 1：不能发起真实网络请求（现在会失败——内置 request 仍然硬编码
		// fetch('http://localhost:7788/proxy', ...)）。
		expect(fetchSpy).not.toHaveBeenCalled()

		// 契约 2：必须落到 invokeApi 的"不支持"分支，errMsg 与 _handleUnsupportedApi
		// 现有格式完全对齐。
		const failMessage = await waitForTriggerCallback(workerIndexBefore, 'req-fail-id', 3000)
		expect(failMessage.body.args.errMsg).toBe('request:fail api is not supported')

		// 顺带确认：不应该错误地走向成功回调。
		const successCall = FakeWorker.instances[workerIndexBefore].postMessage.mock.calls.find(
			([message]: [{ type?: string, body?: { id?: string } }]) => message?.type === 'triggerCallback' && message?.body?.id === 'req-success-id',
		)
		expect(successCall).toBeUndefined()
	}, 10000)

	// 对照用例（预期现在就应该是绿灯）：这条不是在验证"移除"本身，而是验证移除之后
	// request 要走的替代路径——registerApi 优先派发——本来就已经成立，且与其它任意
	// 已注册 API 的行为完全一致（不需要为 request 另开特例）。
	it('宿主通过 registerApi("request", handler) 注册后，invokeApi 派发给该 handler，行为与任意其它已注册 API 一致，且不触发内置实现或真实网络请求', async () => {
		const container = createContainer({ mount })
		const handler = vi.fn()
		container.registerApi('request', handler)

		const workerIndexBefore = FakeWorker.instances.length
		const miniApp = await container.openApp({ appId: 'wx-request-registered', path: 'pages/index/index' })
		await waitForWorker(workerIndexBefore)

		const fetchSpy = vi.fn().mockRejectedValue(new Error('registerApi 命中后不应该再打到网络'))
		globalThis.fetch = fetchSpy

		miniApp.invokeApi('request', { url: 'https://example.com' })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ url: 'https://example.com' }, undefined)
		expect(fetchSpy).not.toHaveBeenCalled()
	}, 10000)
})
