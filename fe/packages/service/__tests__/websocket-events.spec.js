import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failResult, flushMacrotask, loadSocketApi } from './websocket-dimina-harness.js'

// 这个文件覆盖任务态事件注册表本身：一个事件只占一个 bridge callback、终态回收、注册
// 中途失败的回滚。对外形状、payload 字段全集、全局 wx.onSocket* 的语义在
// websocket-dimina-*.spec.js 里断言。
//
// 连接注册表、全局绑定、并发计数都是模块级状态，所以每个用例都用 loadSocketApi() 取一份
// 全新的模块实例：上一个用例遗留的连接（尤其是永远停在 CONNECTING 的那种）会一直占住
// 全局绑定，污染后面的用例。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

describe('Dimina SocketTask 公开接口与事件注册行为', () => {
	it('实例不暴露 socketId、_events 或 off*，原型只保留官方六个方法', () => {
		const { task } = api.connect({ url: 'wss://example.com' })

		expect(Object.getOwnPropertyNames(Object.getPrototypeOf(task)).sort()).toEqual([
			'close',
			'constructor',
			'onClose',
			'onError',
			'onMessage',
			'onOpen',
			'send',
		].sort())
		for (const name of ['socketId', '_events', 'offOpen', 'offMessage', 'offError', 'offClose']) {
			expect(task[name]).toBeUndefined()
			expect(name in task).toBe(false)
		}
	})

	it('不能借 task.constructor 伪造任意内部 socketId 的任务对象', () => {
		const { task } = api.connect({ url: 'wss://example.com' })
		const SocketTaskConstructor = task.constructor

		expect(() => new SocketTaskConstructor('forged-socket-id')).toThrow(TypeError)
	})

	it('send、close 和四个 on* 始终返回 undefined', () => {
		api.bridge.invoke.mockReturnValue('bridge-result')
		const { task } = api.openConnection()

		expect(task.send({ data: 'hello' })).toBeUndefined()
		expect(task.close()).toBeUndefined()
		expect(task.onOpen(vi.fn())).toBeUndefined()
		expect(task.onMessage(vi.fn())).toBeUndefined()
		expect(task.onError(vi.fn())).toBeUndefined()
		expect(task.onClose(vi.fn())).toBeUndefined()
	})

	it('同一任务的多个业务监听只占一个 bridge callback，并按注册顺序派发', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const calls = []
		const first = vi.fn(() => calls.push('first'))
		const second = vi.fn(() => calls.push('second'))

		handle.task.onMessage(first)
		handle.task.onMessage(second)
		handle.task.onMessage(first)

		expect(api.paramsOf('onSocketMessage')).toHaveLength(1)
		api.fire(handle, 'message', { data: 'hello' })
		expect(calls).toEqual(['first', 'second'])
		expect(first).toHaveBeenCalledWith({ data: 'hello' })
		expect(second).toHaveBeenCalledWith({ data: 'hello' })
	})

	it('连接已打开后的普通 error 不向后来注册的 listener 补发', async () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const first = vi.fn()
		handle.task.onError(first)
		api.fire(handle, 'open', { header: {} })
		api.fire(handle, 'error', { errMsg: 'temporary' })
		await flushMacrotask()

		const late = vi.fn()
		handle.task.onError(late)
		await flushMacrotask()

		expect(first).toHaveBeenCalledWith({ errMsg: 'temporary' })
		expect(late).not.toHaveBeenCalled()
	})

	it('close 后回收四个 keep callback，迟到的 message 不再派发', async () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const message = vi.fn()
		const close = vi.fn()
		handle.task.onMessage(message)
		handle.task.onClose(close)
		const messageId = api.lastParamsOf('onSocketMessage').callback

		api.fire(handle, 'close', { code: 1000, reason: 'done' })
		api.callback.invoke(messageId, { data: 'late' })
		await flushMacrotask()

		expect(close).toHaveBeenCalledWith({ code: 1000, reason: 'done' })
		expect(message).not.toHaveBeenCalled()
		expect(api.paramsOf('onSocketClose')).toHaveLength(1)
	})

	it('connectSocket 前置失败也封住任务，不等待不会到来的 error/close', () => {
		const fail = vi.fn()
		const handle = api.connect({ url: 'wss://example.com', fail })
		const message = vi.fn()
		handle.task.onMessage(message)
		const messageId = api.lastParamsOf('onSocketMessage').callback

		const error = { errMsg: 'connectSocket:fail invalid url' }
		api.callback.invoke(handle.params.fail, error)
		api.callback.invoke(messageId, { data: 'late' })

		expect(fail).toHaveBeenCalledWith(error)
		expect(message).not.toHaveBeenCalled()
	})

	// 四个事件在 connectSocket 当场一起登记，所以「中途某个 on* 桥调用失败」发生在
	// connectSocket 内部：已登记的那几个要用内部 off 桥摘掉，异常不外抛，走 fail 回调。
	it('四事件登记中途同步失败时用内部 off 桥回滚已登记项，并走 fail 而不是把异常抛给调用方', () => {
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'onSocketMessage') throw new Error('bridge down')
		})
		const fail = vi.fn()

		let task
		expect(() => {
			task = api.connectSocket({ url: 'wss://example.com', fail })
		}).not.toThrow()

		expect(task).toBeUndefined()
		expect(failResult(fail).errMsg).toBe('connectSocket:fail bridge down')
		const open = api.lastParamsOf('onSocketOpen')
		expect(api.lastParamsOf('offSocketOpen')).toEqual({
			socketId: open.socketId,
			callback: open.callback,
		})
	})

	it('内部 off 回滚本身再抛错也不外泄异常，fail 报的仍是最初那个失败原因', () => {
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'onSocketMessage') throw new Error('register down')
			if (msg.body.name === 'offSocketOpen') throw new Error('rollback down')
		})
		const fail = vi.fn()

		let task
		expect(() => {
			task = api.connectSocket({ url: 'wss://example.com/boom', fail })
		}).not.toThrow()

		expect(task).toBeUndefined()
		// 回滚失败不能把真正的原因盖掉。
		expect(failResult(fail).errMsg).toBe('connectSocket:fail register down')
	})

	it('回滚失败的连接不留在注册表里，也不占住全局绑定', () => {
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'onSocketMessage') throw new Error('register down')
			if (msg.body.name === 'offSocketOpen') throw new Error('rollback down')
		})
		api.connectSocket({ url: 'wss://example.com/boom', fail: vi.fn() })

		api.bridge.invoke.mockImplementation(() => 'invoke-result')
		const fresh = api.openConnection('wss://example.com/fresh')
		api.sendSocketMessage({ data: 'hi' })

		const sent = api.paramsForSocket('sendSocketMessage', fresh.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('hi')
	})
})
