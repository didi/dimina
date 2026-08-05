import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { connectSocket, offSocketMessage, offSocketOpen, onSocketMessage, onSocketOpen } from '../src/api/core/network/websocket/index.js'

// 一个用例里会下发多次桥调用，所以不按调用下标取参数，按接口名取最后一次命中。
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

	it('removes every registered listener by id when off() is called without a listener', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const first = vi.fn()
		const second = vi.fn()
		task.onClose(first)
		const firstId = lastParamsOf('onSocketClose').callback
		task.onClose(second)
		const secondId = lastParamsOf('onSocketClose').callback
		expect(firstId).not.toBe(secondId)

		task.offClose()

		// 不带监听的 off 逐个按 id 摘，绝不给原生发一条「清空该事件全部监听」：
		// 清空只让原生把监听扔掉，本地登记表和全局回调表里的闭包还留着。
		const offCalls = paramsOfAll('offSocketClose')
		expect(offCalls.map(params => params.callback)).toEqual([firstId, secondId])
		expect(offCalls.some(params => params.callback === undefined)).toBe(false)

		callback.invoke(firstId, { code: 1000, reason: '' })
		callback.invoke(secondId, { code: 1000, reason: '' })
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
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

// 需求一：off() 下发注销请求时，如果 invokeAPI 同步抛错，说明原生根本没收到这次注销，
// 脚本层的本地状态（谁还注册着、callback 表里那条登记）必须保持「未注销」，否则原生
// 之后按这个 id 推事件时，脚本层已经把它忘掉，事件就丢了。
//
// 这些测试专门操作全局的 onSocketMessage/offSocketMessage：每个 it 结束前都会把自己
// 注册的监听通过一次成功的 off() 摘干净——全局监听的登记表是模块级别的单例状态，不会
// 像 SocketTask 那样随每个 `connectSocket()` 产生的新实例一起被隔离，不清干净会串到
// 后面的用例里，导致后面的「逐个注销全部监听」断言把这里剩下的也算进去。
describe('off() rolls back local state when invokeAPI throws synchronously (global listeners)', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('propagates the invokeAPI exception instead of swallowing it', () => {
		const listener = vi.fn()
		onSocketMessage(listener)

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => offSocketMessage(listener)).toThrow('bridge down')

		// bridge 恢复后清理，避免残留监听影响后面的用例
		offSocketMessage(listener)
	})

	it('retries with the exact same callback id after a failed unregister attempt', () => {
		const listener = vi.fn()
		onSocketMessage(listener)
		const registeredId = lastParamsOf('onSocketMessage').callback

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => offSocketMessage(listener)).toThrow('bridge down')

		// bridge 恢复正常，重试必须真的再向原生发一次注销请求，而且 id 跟第一次完全一样——
		// 不能因为第一次失败就把这个 id 在本地「忘掉」，变成重试时发一个新 id 或者干脆不发。
		offSocketMessage(listener)

		const offCalls = paramsOfAll('offSocketMessage')
		expect(offCalls).toHaveLength(2)
		expect(offCalls[0].callback).toBe(registeredId)
		expect(offCalls[1].callback).toBe(registeredId)
	})

	it('keeps the callback registry entry alive after a failed off(), so a late native push still reaches the listener', () => {
		const listener = vi.fn()
		onSocketMessage(listener)
		const registeredId = lastParamsOf('onSocketMessage').callback

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => offSocketMessage(listener)).toThrow('bridge down')

		// 原生从没收到这次注销请求，它仍然可能按这个 id 推事件过来；@dimina/common 的
		// callback 表里这条登记必须还在，否则事件到了也派发不出去。
		callback.invoke(registeredId, { data: 'late message' })
		expect(listener).toHaveBeenCalledWith({ data: 'late message' })

		offSocketMessage(listener)
	})

	it('off() without a listener stops at the first failure: already-removed listeners do not linger, the failing one and the rest stay retryable', () => {
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		const listener3 = vi.fn()
		onSocketMessage(listener1)
		onSocketMessage(listener2)
		onSocketMessage(listener3)

		const ids = paramsOfAll('onSocketMessage').map(params => params.callback)
		expect(new Set(ids).size).toBe(3)

		// 让第 2 个 offSocketMessage 调用（对应 listener2）同步抛错，第 1 个（listener1）
		// 正常成功，第 3 个（listener3）根本不会被尝试到。
		let offAttempts = 0
		vi.mocked(invokeAPI).mockImplementation((apiName) => {
			if (apiName === 'offSocketMessage') {
				offAttempts += 1
				if (offAttempts === 2) {
					throw new Error('bridge down')
				}
			}
			return undefined
		})

		expect(() => offSocketMessage()).toThrow('bridge down')

		const attemptedIds = paramsOfAll('offSocketMessage').map(params => params.callback)
		expect(attemptedIds).toEqual([ids[0], ids[1]])

		// listener1 已经成功注销、不能残留在本地表里：再对它调用 off() 必须是纯粹的
		// no-op，既不应该再向原生发请求，也不应该还能收到事件。
		vi.mocked(invokeAPI).mockClear()
		offSocketMessage(listener1)
		expect(invokeAPI).not.toHaveBeenCalled()
		callback.invoke(ids[0], { data: 'should not reach listener1' })
		expect(listener1).not.toHaveBeenCalled()

		// listener2（失败的那个）和 listener3（还没尝试到的）必须仍然留在本地表里、可以重试。
		offSocketMessage(listener2)
		expect(invokeAPI).toHaveBeenLastCalledWith('offSocketMessage', {
			callback: ids[1],
			keep: true,
		})

		callback.invoke(ids[2], { data: 'listener3 still wired' })
		expect(listener3).toHaveBeenCalledWith({ data: 'listener3 still wired' })
		offSocketMessage(listener3)
	})
})

// 同一条 off() 回滚契约，换成 SocketTask 的任务态接口（task.onMessage/offMessage）验证一遍。
// SocketTask 的监听表挂在每个 connectSocket() 产生的实例上，天然跟其它用例隔离，这里不需要
// 像上面全局监听那样手动清理。
describe('off() rolls back local state when invokeAPI throws synchronously (SocketTask listeners)', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('task.offMessage propagates the exception, keeps the registry entry alive, and retries with the same callback id', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onMessage(listener)
		const registeredId = lastParamsOf('onSocketMessage').callback

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => task.offMessage(listener)).toThrow('bridge down')

		// 原生没收到这次注销请求，仍可能按这个 id 推消息过来，listener 必须还收得到。
		callback.invoke(registeredId, { data: 'late message' })
		expect(listener).toHaveBeenCalledWith({ data: 'late message' })

		// bridge 恢复后重试，必须真的再发一次注销请求，且 id 跟第一次相同。
		expect(() => task.offMessage(listener)).not.toThrow()
		const offCalls = paramsOfAll('offSocketMessage')
		expect(offCalls).toHaveLength(2)
		expect(offCalls[0].callback).toBe(registeredId)
		expect(offCalls[1].callback).toBe(registeredId)
	})
})

// 需求二：同一个全局事件上注册多个监听，彼此不能互相覆盖。每个 it 结束前都会清理自己注册的
// 监听，理由同上——全局监听表是模块级单例状态，不清理会串到后面的用例。
describe('global listeners: multiple registrations on the same event coexist independently (onSocketMessage)', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('two different listeners each get their own callback id and only receive their own native push', () => {
		const fn1 = vi.fn()
		const fn2 = vi.fn()
		onSocketMessage(fn1)
		onSocketMessage(fn2)

		const ids = paramsOfAll('onSocketMessage').map(params => params.callback)
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])

		callback.invoke(ids[0], { data: 'to fn1' })
		expect(fn1).toHaveBeenCalledWith({ data: 'to fn1' })
		expect(fn2).not.toHaveBeenCalled()

		callback.invoke(ids[1], { data: 'to fn2' })
		expect(fn2).toHaveBeenCalledWith({ data: 'to fn2' })
		expect(fn1).toHaveBeenCalledTimes(1)

		offSocketMessage(fn1)
		offSocketMessage(fn2)
	})

	it('removing one listener leaves the other listener on the same event registered and reachable', () => {
		const fn1 = vi.fn()
		const fn2 = vi.fn()
		onSocketMessage(fn1)
		onSocketMessage(fn2)
		const ids = paramsOfAll('onSocketMessage').map(params => params.callback)

		offSocketMessage(fn1)
		expect(invokeAPI).toHaveBeenLastCalledWith('offSocketMessage', {
			callback: ids[0],
			keep: true,
		})

		callback.invoke(ids[1], { data: 'still reaches fn2' })
		expect(fn2).toHaveBeenCalledWith({ data: 'still reaches fn2' })

		offSocketMessage(fn2)
	})

	it('registering the exact same listener function twice on the same event only sends one registration request', () => {
		const fn1 = vi.fn()
		onSocketMessage(fn1)
		onSocketMessage(fn1)

		expect(paramsOfAll('onSocketMessage')).toHaveLength(1)

		offSocketMessage(fn1)
	})
})

// 需求二的另一个事件：onSocketOpen，验证同一套契约不是 onSocketMessage 独有的。
describe('global listeners: multiple registrations on the same event coexist independently (onSocketOpen)', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('two different listeners each get their own callback id and only receive their own native push', () => {
		const fn1 = vi.fn()
		const fn2 = vi.fn()
		onSocketOpen(fn1)
		onSocketOpen(fn2)

		const ids = paramsOfAll('onSocketOpen').map(params => params.callback)
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])

		callback.invoke(ids[0], {})
		expect(fn1).toHaveBeenCalledTimes(1)
		expect(fn2).not.toHaveBeenCalled()

		callback.invoke(ids[1], {})
		expect(fn2).toHaveBeenCalledTimes(1)
		expect(fn1).toHaveBeenCalledTimes(1)

		offSocketOpen(fn1)
		offSocketOpen(fn2)
	})

	it('removing one listener leaves the other listener on the same event registered and reachable', () => {
		const fn1 = vi.fn()
		const fn2 = vi.fn()
		onSocketOpen(fn1)
		onSocketOpen(fn2)
		const ids = paramsOfAll('onSocketOpen').map(params => params.callback)

		offSocketOpen(fn1)
		expect(invokeAPI).toHaveBeenLastCalledWith('offSocketOpen', {
			callback: ids[0],
			keep: true,
		})

		callback.invoke(ids[1], {})
		expect(fn2).toHaveBeenCalledTimes(1)

		offSocketOpen(fn2)
	})

	it('registering the exact same listener function twice on the same event only sends one registration request', () => {
		const fn1 = vi.fn()
		onSocketOpen(fn1)
		onSocketOpen(fn1)

		expect(paramsOfAll('onSocketOpen')).toHaveLength(1)

		offSocketOpen(fn1)
	})
})
