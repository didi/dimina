import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { connectSocket, offSocketMessage, onSocketMessage } from '../src/api/core/network/websocket/index.js'

// connectSocket 下发之后会给 open/error/close 各注册一个维护 readyState 的内部监听，
// 所以不能按调用下标取参数，按接口名取最后一次调用才不受注册顺序影响。
function lastParamsOf(apiName) {
	const calls = vi.mocked(invokeAPI).mock.calls.filter(call => call[0] === apiName)
	if (calls.length === 0) {
		throw new Error(`invokeAPI was never called with ${apiName}`)
	}
	return calls[calls.length - 1][1]
}

function paramsOfAll(apiName) {
	return vi.mocked(invokeAPI).mock.calls.filter(call => call[0] === apiName).map(call => call[1])
}

describe('websocket event callback registry', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('removes a SocketTask listener by its bridge callback id', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onMessage(listener)

		const onParams = lastParamsOf('onSocketMessage')
		expect(onParams.callback).toEqual(expect.any(String))

		task.offMessage(listener)

		expect(invokeAPI).toHaveBeenLastCalledWith('offSocketMessage', {
			socketId: task.socketId,
			callback: onParams.callback,
			keep: true,
		})
		callback.invoke(onParams.callback, { data: 'late message' })
		expect(listener).not.toHaveBeenCalled()
	})

	it('keeps registrations for the same listener isolated by event', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onOpen(listener)
		task.onMessage(listener)

		const openId = lastParamsOf('onSocketOpen').callback
		const messageId = lastParamsOf('onSocketMessage').callback
		expect(openId).not.toBe(messageId)

		task.offOpen(listener)
		callback.invoke(messageId, { data: 'message' })
		expect(listener).toHaveBeenCalledWith({ data: 'message' })
	})

	it('keeps the readyState listener alive when off() is called without a listener', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const internalCloseId = lastParamsOf('onSocketClose').callback
		const listener = vi.fn()
		task.onClose(listener)
		const userCloseId = lastParamsOf('onSocketClose').callback
		expect(userCloseId).not.toBe(internalCloseId)

		task.offClose()

		// 不带监听的 off 只能逐个摘掉调用方注册的那些，绝不能给原生发一条
		// 「清空该事件全部监听」——内部维护 readyState 的那个也在原生列表里，
		// 清空再补回中间的窗口会让终态事件永久丢失。
		const offCalls = paramsOfAll('offSocketClose')
		expect(offCalls).toHaveLength(1)
		expect(offCalls[0].callback).toBe(userCloseId)
		expect(offCalls.some(params => params.callback === undefined)).toBe(false)

		// 内部监听没被摘，close 事件仍然能把 readyState 推到 CLOSED
		callback.invoke(internalCloseId, { code: 1000, reason: '' })
		expect(task.readyState).toBe(3)
		expect(listener).not.toHaveBeenCalled()
	})

	it('does not roll a terminal readyState back to the pre-close state when close fails', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const internalOpenId = lastParamsOf('onSocketOpen').callback
		const internalCloseId = lastParamsOf('onSocketClose').callback
		callback.invoke(internalOpenId, {})
		expect(task.readyState).toBe(1)

		task.close({ code: 5000 })
		expect(task.readyState).toBe(2)

		// 远端的 close 先到，状态已经是终态；随后原生才回这次 close 的 fail。
		callback.invoke(internalCloseId, { code: 1006, reason: 'remote' })
		expect(task.readyState).toBe(3)

		const closeParams = lastParamsOf('closeSocket')
		callback.invoke(closeParams.fail, { errMsg: 'closeSocket:fail not connected' })
		expect(task.readyState).toBe(3)
	})

	it('drops the readyState listeners once the connection is terminal', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const internalOpenId = lastParamsOf('onSocketOpen').callback
		const internalCloseId = lastParamsOf('onSocketClose').callback

		callback.invoke(internalCloseId, { code: 1000, reason: '' })
		expect(task.readyState).toBe(3)

		// 终态之后这几个回调不可能再被触发，必须从全局 registry 里摘掉，
		// 否则每建一条连接就永久多留几个闭包。
		callback.invoke(internalOpenId, {})
		expect(task.readyState).toBe(3)
	})

	it('drops the readyState listeners when the connection is rejected outright', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const internalOpenId = lastParamsOf('onSocketOpen').callback

		// 超并发上限、URL 不合法这类拒绝只回 connectSocket 的 fail，之后既没有
		// error 也没有 close 事件，内部监听只能在这条路径上摘掉。
		callback.invoke(lastParamsOf('connectSocket').fail, { errMsg: 'connectSocket:fail reach max websocket connect count 5' })
		expect(task.readyState).toBe(3)

		callback.invoke(internalOpenId, {})
		expect(task.readyState).toBe(3)
	})

	it('drops the unused settler when connectSocket succeeds', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const connectParams = lastParamsOf('connectSocket')
		const internalOpenId = lastParamsOf('onSocketOpen').callback

		// 一次调用只会走 success 或 fail 其中一条，没走的那条必须一起摘掉，
		// 否则每成功连接一次就在回调表里永久留下一个捕获了 SocketTask 的闭包。
		callback.invoke(connectParams.success, { errMsg: 'connectSocket:ok' })
		callback.invoke(internalOpenId, {})
		expect(task.readyState).toBe(1)

		// fail 已经失效，投过来也不该再把状态推到 CLOSED
		callback.invoke(connectParams.fail, { errMsg: 'connectSocket:fail' })
		expect(task.readyState).toBe(1)
	})

	it('drops the unused settler when close succeeds', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		callback.invoke(lastParamsOf('onSocketOpen').callback, {})
		expect(task.readyState).toBe(1)

		task.close({})
		const closeParams = lastParamsOf('closeSocket')
		callback.invoke(closeParams.success, { errMsg: 'closeSocket:ok' })
		expect(task.readyState).toBe(2)

		// 关闭已经受理，这条 fail 必须已经失效，不能再把状态回滚成 OPEN
		callback.invoke(closeParams.fail, { errMsg: 'closeSocket:fail' })
		expect(task.readyState).toBe(2)
	})

	it('supports removing global socket listeners', () => {
		const listener = vi.fn()
		onSocketMessage(listener)
		const callbackId = vi.mocked(invokeAPI).mock.calls[0][1].callback

		offSocketMessage(listener)

		expect(invokeAPI).toHaveBeenLastCalledWith('offSocketMessage', {
			callback: callbackId,
			keep: true,
		})
	})
})
