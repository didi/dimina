import { describe, expect, it, vi } from 'vitest'

// 这个文件故意不 mock `@/api/common`：websocket-events.spec.js 把 invokeAPI 整体打了桩，
// 只能证明 WebSocket 模块「认为」自己把裸函数交给了 invokeAPI，证明不了真的接上了
// invokeAPI 的配对登记链路。这里换成 mock 更底层的桥（message.js 最终落到的
// globalThis.DiminaServiceBridge），让 invokeAPI 和 WebSocket 模块都是真实代码。
async function loadWebsocketApi() {
	vi.resetModules()
	globalThis.DiminaServiceBridge = {
		onMessage: null,
		invoke: vi.fn(() => 'invoke-result'),
		publish: vi.fn(() => 'publish-result'),
	}

	const [{ connectSocket }, { callback }] = await Promise.all([
		import('../src/api/core/network/websocket/index.js'),
		import('@dimina/common'),
	])

	return {
		bridge: globalThis.DiminaServiceBridge,
		callback,
		connectSocket,
	}
}

// 一个用例里会下发多次桥调用，所以不按调用下标取参数，按接口名过滤取最后一次命中。
function paramsOfAll(bridge, apiName) {
	return bridge.invoke.mock.calls
		.filter(call => call[0].body.name === apiName)
		.map(call => call[0].body.params)
}

function lastParamsOf(bridge, apiName) {
	const all = paramsOfAll(bridge, apiName)
	if (all.length === 0) {
		throw new Error(`invoke was never called with ${apiName}`)
	}
	return all[all.length - 1]
}

describe('connectSocket 真的把 success/fail 交给了 invokeAPI 登记', () => {
	it('下发给桥的 connectSocket 参数里，success 和 fail 都是非空字符串 id，不是裸函数', async () => {
		const { bridge, connectSocket } = await loadWebsocketApi()

		connectSocket({ url: 'wss://example.com', success: vi.fn(), fail: vi.fn() })

		const params = lastParamsOf(bridge, 'connectSocket')
		expect(typeof params.success).toBe('string')
		expect(params.success).not.toBe('')
		expect(typeof params.fail).toBe('string')
		expect(params.fail).not.toBe('')
	})

	it('任一条 settler 触发后另一条失效，回调表不残留', async () => {
		const { bridge, callback, connectSocket } = await loadWebsocketApi()

		const success = vi.fn()
		const fail = vi.fn()
		connectSocket({ url: 'wss://example.com', success, fail })
		const params = lastParamsOf(bridge, 'connectSocket')

		callback.invoke(params.success, { errMsg: 'connectSocket:ok' })
		expect(success).toHaveBeenCalledTimes(1)

		// 成对登记：success 到账时 fail 那条也一起被回收，迟到的 fail 不该再被派发。
		callback.invoke(params.fail, { errMsg: 'connectSocket:fail already resolved' })
		expect(fail).not.toHaveBeenCalled()
	})
})

describe('SocketTask.close 真的把 success/fail 交给了 invokeAPI 登记', () => {
	it('下发给桥的 closeSocket 参数里，success 和 fail 都是非空字符串 id，任一条触发后另一条失效', async () => {
		const { bridge, callback, connectSocket } = await loadWebsocketApi()
		const task = connectSocket({ url: 'wss://example.com' })

		const success = vi.fn()
		const fail = vi.fn()
		task.close({ success, fail })

		const params = lastParamsOf(bridge, 'closeSocket')
		expect(typeof params.success).toBe('string')
		expect(params.success).not.toBe('')
		expect(typeof params.fail).toBe('string')
		expect(params.fail).not.toBe('')

		callback.invoke(params.success, { errMsg: 'closeSocket:ok' })
		expect(success).toHaveBeenCalled()

		callback.invoke(params.fail, { errMsg: 'closeSocket:fail already closed' })
		expect(fail).not.toHaveBeenCalled()
	})
})
