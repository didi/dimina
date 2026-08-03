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

// connectSocket 下发之后还会给 open/error/close 各注册一个内部监听，所以不能按
// 调用下标取参数，要按接口名过滤，取最后一次命中的那次调用。
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

		connectSocket({ url: 'wss://example.com' })

		const params = lastParamsOf(bridge, 'connectSocket')
		expect(typeof params.success).toBe('string')
		expect(params.success).not.toBe('')
		expect(typeof params.fail).toBe('string')
		expect(params.fail).not.toBe('')
	})

	it('success 先到账（原生受理了连接）之后，一条迟到失效的 fail 不能把 readyState 打成 CLOSED', async () => {
		const { bridge, callback, connectSocket } = await loadWebsocketApi()

		const task = connectSocket({ url: 'wss://example.com' })
		const params = lastParamsOf(bridge, 'connectSocket')

		callback.invoke(params.success, { errMsg: 'connectSocket:ok' })
		callback.invoke(params.fail, { errMsg: 'connectSocket:fail already resolved' })

		// connectSocket 的 success 只表示原生受理了连接请求、握手还没完成，
		// 此时状态应当严格是 0（连接中），而不是任何非 3 的值都算过关。
		expect(task.readyState).toBe(0)
	})

	it('连接被直接拒绝，只有 fail 到账时，readyState 必须变成 CLOSED，之后迟到的 success 也救不回来', async () => {
		const { bridge, callback, connectSocket } = await loadWebsocketApi()

		const task = connectSocket({ url: 'wss://example.com' })
		const params = lastParamsOf(bridge, 'connectSocket')

		callback.invoke(params.fail, { errMsg: 'connectSocket:fail reach max websocket connect count 5' })
		expect(task.readyState).toBe(3)

		callback.invoke(params.success, { errMsg: 'connectSocket:ok' })
		expect(task.readyState).toBe(3)
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

describe('SocketTask.close 下发抛错时必须回滚 readyState', () => {
	it('已连接(readyState=1)时下发抛错，close() 照常抛异常，但 readyState 恢复成抛错之前的值；桥恢复正常后重试能正常走完', async () => {
		const { bridge, callback, connectSocket } = await loadWebsocketApi()
		const task = connectSocket({ url: 'wss://example.com' })

		const openId = lastParamsOf(bridge, 'onSocketOpen').callback
		callback.invoke(openId, {})
		expect(task.readyState).toBe(1)

		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => task.close({})).toThrow('bridge down')
		// close() 先把 readyState 乐观置成 CLOSING，下发抛错之后必须回滚回调用前的值。
		expect(task.readyState).toBe(1)

		// 桥恢复正常，重试 close() 必须能正常走完，不能被上一次失败卡死。
		expect(() => task.close({})).not.toThrow()
		expect(task.readyState).toBe(2)

		const closeParams = lastParamsOf(bridge, 'closeSocket')
		// 触发这次成功下发的 success 不应该抛异常；readyState 真正变成终态(CLOSED)
		// 是由 onSocketClose 事件驱动的（见 websocket-events.spec.js），closeSocket
		// 自身的 success 只表示原生受理了关闭请求，所以这里状态应当仍停在 CLOSING。
		expect(() => callback.invoke(closeParams.success, { errMsg: 'closeSocket:ok' })).not.toThrow()
		expect(task.readyState).toBe(2)
	})

	it('连接中(readyState=0，还没收到 open)时下发抛错，readyState 恢复成 0 而不是留在 CLOSING', async () => {
		const { bridge, connectSocket } = await loadWebsocketApi()
		const task = connectSocket({ url: 'wss://example.com' })

		expect(task.readyState).toBe(0)

		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => task.close({})).toThrow('bridge down')
		expect(task.readyState).toBe(0)
	})
})
