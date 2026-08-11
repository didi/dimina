import { describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

// 这个文件故意不 mock `@/api/common`：websocket-events.spec.js 把 invokeAPI 整体打了桩，
// 只能证明 WebSocket 模块「认为」自己把裸函数交给了 invokeAPI，证明不了真的接上了
// invokeAPI 的配对登记链路。共用加载器打桩的是更底层的桥（message.js 最终落到的
// globalThis.DiminaServiceBridge），让 invokeAPI 和 WebSocket 模块都是真实代码。

describe('connectSocket 真的把 success/fail 交给了 invokeAPI 登记', () => {
	it('下发给桥的 connectSocket 参数里，success 和 fail 都是非空字符串 id，不是裸函数', async () => {
		const api = await loadSocketApi()

		api.connectSocket({ url: 'wss://example.com', success: vi.fn(), fail: vi.fn() })

		const params = api.lastParamsOf('connectSocket')
		expect(typeof params.success).toBe('string')
		expect(params.success).not.toBe('')
		expect(typeof params.fail).toBe('string')
		expect(params.fail).not.toBe('')
	})

	it('任一条 settler 触发后另一条失效，回调表不残留', async () => {
		const api = await loadSocketApi()

		const success = vi.fn()
		const fail = vi.fn()
		api.connectSocket({ url: 'wss://example.com', success, fail })
		const params = api.lastParamsOf('connectSocket')

		api.callback.invoke(params.success, { errMsg: 'connectSocket:ok' })
		expect(success).toHaveBeenCalledTimes(1)

		// 成对登记：success 到账时 fail 那条也一起被回收，迟到的 fail 不该再被派发。
		api.callback.invoke(params.fail, { errMsg: 'connectSocket:fail already resolved' })
		expect(fail).not.toHaveBeenCalled()
	})
})

describe('SocketTask.close 真的把 success/fail 交给了 invokeAPI 登记', () => {
	it('下发给桥的 closeSocket 参数里，success 和 fail 都是非空字符串 id，任一条触发后另一条失效', async () => {
		const api = await loadSocketApi()
		const { task } = api.openConnection()

		const success = vi.fn()
		const fail = vi.fn()
		task.close({ success, fail })

		const params = api.lastParamsOf('closeSocket')
		expect(typeof params.success).toBe('string')
		expect(params.success).not.toBe('')
		expect(typeof params.fail).toBe('string')
		expect(params.fail).not.toBe('')

		api.callback.invoke(params.success, { errMsg: 'closeSocket:ok' })
		expect(success).toHaveBeenCalled()

		api.callback.invoke(params.fail, { errMsg: 'closeSocket:fail already closed' })
		expect(fail).not.toHaveBeenCalled()
	})
})

describe('task void 与全局 Promisify 分流', () => {
	// send 只允许已打开连接，所以这几条都要先触发 open，
	// 否则验的是 fail 分支而不是返回值形态。
	it('SocketTask.send/close 无回调时返回 undefined，也不暗中创建 Promise settler', async () => {
		const api = await loadSocketApi()
		const { task } = api.openConnection()

		expect(task.send({ data: 'hello' })).toBeUndefined()
		expect(task.close()).toBeUndefined()
		for (const name of ['sendSocketMessage', 'closeSocket']) {
			const params = api.lastParamsOf(name)
			expect(params).not.toHaveProperty('success')
			expect(params).not.toHaveProperty('fail')
		}
	})

	it('全局 sendSocketMessage 和无参 closeSocket 仍按微信支持 Promise', async () => {
		const api = await loadSocketApi()
		api.openConnection()

		const sendPromise = api.sendSocketMessage({ data: 'hello' })
		expect(sendPromise).toBeInstanceOf(Promise)
		const sendParams = api.lastParamsOf('sendSocketMessage')
		api.callback.invoke(sendParams.success, { errMsg: 'sendSocketMessage:ok' })
		await expect(sendPromise).resolves.toEqual({ errMsg: 'sendSocketMessage:ok' })

		const closePromise = api.closeSocket()
		expect(closePromise).toBeInstanceOf(Promise)
		const closeParams = api.lastParamsOf('closeSocket')
		api.callback.invoke(closeParams.success, { errMsg: 'closeSocket:ok' })
		await expect(closePromise).resolves.toEqual({ errMsg: 'closeSocket:ok' })
	})

	it('全局 sendSocketMessage/closeSocket 传 callback 时返回 undefined', async () => {
		const api = await loadSocketApi()
		api.openConnection()

		expect(api.sendSocketMessage({ data: 'hello', success: vi.fn() })).toBeUndefined()
		expect(api.closeSocket({ complete: vi.fn() })).toBeUndefined()
	})
})
