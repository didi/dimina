import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failResult, flushMacrotask, loadSocketApi } from './websocket-dimina-harness.js'

// 本文件覆盖公开参数、事件 payload，以及微信未定义的 Dimina 全局路由与监听行为。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

function sendParamsForSocket(socketId) {
	return api.paramsForSocket('sendSocketMessage', socketId)
}

function closeParamsForSocket(socketId) {
	return api.paramsForSocket('closeSocket', socketId)
}

describe('SocketTask.send', () => {
	it('连接尚未打开时走 fail，且不下发 native', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const fail = vi.fn()

		handle.task.send({ data: 'hello', fail })

		expect(failResult(fail).errMsg).toBe('SocketTask.send:fail WebSocket is not connected')
		expect(api.paramsOf('sendSocketMessage')).toHaveLength(0)
	})

	it('连接已关闭后再 send 同样走 fail', async () => {
		const handle = api.openConnection()
		api.fire(handle, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fail = vi.fn()

		handle.task.send({ data: 'hello', fail })

		expect(failResult(fail).errMsg).toBe('SocketTask.send:fail WebSocket is not connected')
	})

	it('OPEN 之后字符串原样下发，不带 isBuffer', () => {
		const handle = api.openConnection()

		handle.task.send({ data: 'hello' })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('OPEN 之后 ArrayBuffer 转 base64 并打 isBuffer:true', () => {
		const handle = api.openConnection()

		handle.task.send({ data: Uint8Array.from([1, 2, 3]).buffer })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('AQID')
		expect(params.isBuffer).toBe(true)
	})

	it.each([
		['TypedArray', new Uint8Array([1, 2, 3])],
		['DataView', new DataView(new Uint8Array([1, 2, 3]).buffer)],
	])('%s 不被自动转成 ArrayBuffer，原样交给 native 拒绝', (_case, data) => {
		const handle = api.openConnection()

		handle.task.send({ data })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(data)
		expect(params).not.toHaveProperty('isBuffer')
	})
})

describe('SocketTask.close 的 code / reason', () => {
	it.each([
		['字符串 "1000"', '1000'],
		['null', null],
		['布尔 true', true],
		['对象', {}],
		['数组', []],
		['不传', undefined],
	])('code 是%s（非 Number）时回落成 1000', (_case, code) => {
		const handle = api.openConnection()

		handle.task.close(code === undefined ? {} : { code })

		expect(api.lastParamsOf('closeSocket').code).toBe(1000)
	})

	// 非有限数的 code 与非 Number 同一处理：JSON 桥会把 NaN/Infinity 变成 null，
	// JSValue 桥原样保留后被 native 按非法 code 拒绝，三端必然分叉。
	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
	])('code 是 %s 这类非有限数时回落成 1000', (_case, code) => {
		const handle = api.openConnection()

		handle.task.close({ code })

		expect(api.lastParamsOf('closeSocket').code).toBe(1000)
	})

	it('全局 closeSocket 的非有限数 code 同样回落成 1000', () => {
		const handle = api.openConnection()

		api.closeSocket({ code: Number.NaN, fail: vi.fn() })

		expect(api.paramsForSocket('closeSocket', handle.socketId)[0].code).toBe(1000)
	})

	it('JS 层不做 RFC6455 范围校验，超出范围的 number 原样下发', () => {
		const handle = api.openConnection()

		handle.task.close({ code: 5 })

		expect(api.lastParamsOf('closeSocket').code).toBe(5)
	})

	it('不传 reason 时不代填空串', () => {
		const handle = api.openConnection()

		handle.task.close({ code: 1000 })

		expect(api.lastParamsOf('closeSocket').reason).toBeUndefined()
	})

	it.each([
		['超 123 字节的长串', 'x'.repeat(200)],
		['非字符串', { a: 1 }],
	])('reason 是%s时完全不加工，原样下发', (_case, reason) => {
		const handle = api.openConnection()

		handle.task.close({ reason })

		expect(api.lastParamsOf('closeSocket').reason).toEqual(reason)
	})
})

describe('事件 payload 字段全集', () => {
	it('任务态 open 只投影 header 与 profile，内部字段不泄漏', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()
		handle.task.onOpen(listener)

		api.fire(handle, 'open', {
			header: { Upgrade: 'websocket' },
			profile: { fetchStart: 1, cost: 2 },
			socketId: handle.socketId,
			state: 'open',
		})

		expect(listener).toHaveBeenCalledWith({
			header: { Upgrade: 'websocket' },
			profile: { fetchStart: 1, cost: 2 },
		})
	})

	it('全局 open 只有 header，没有 profile', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()
		api.onSocketOpen(listener)

		api.fire(handle, 'open', { header: { Upgrade: 'websocket' }, profile: { cost: 2 } })

		expect(listener).toHaveBeenCalledWith({ header: { Upgrade: 'websocket' } })
	})

	it('message 只投影 data，isBuffer 与 socketId 不泄漏', () => {
		const handle = api.openConnection()
		const listener = vi.fn()
		handle.task.onMessage(listener)

		api.fire(handle, 'message', { data: 'AQI=', isBuffer: true, socketId: handle.socketId })

		const result = listener.mock.calls[0][0]
		expect(Object.keys(result)).toEqual(['data'])
		expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2]))
	})

	it('error 只投影 errMsg，不带运行时的 errCode', async () => {
		const handle = api.openConnection()
		const listener = vi.fn()
		handle.task.onError(listener)

		api.fire(handle, 'error', { errMsg: 'boom', errCode: 4001, socketId: handle.socketId })
		await flushMacrotask()

		expect(listener).toHaveBeenCalledWith({ errMsg: 'boom' })
	})

	it('close 只投影 code 与 reason，不带 W3C 的 wasClean', async () => {
		const handle = api.openConnection()
		const listener = vi.fn()
		handle.task.onClose(listener)

		api.fire(handle, 'close', { code: 1000, reason: 'bye', wasClean: true, socketId: handle.socketId })
		await flushMacrotask()

		expect(listener).toHaveBeenCalledWith({ code: 1000, reason: 'bye' })
	})

	it('全局 message / close 与任务态共用同一份投影结果', async () => {
		const handle = api.openConnection()
		const message = vi.fn()
		const close = vi.fn()
		api.onSocketMessage(message)
		api.onSocketClose(close)

		api.fire(handle, 'message', { data: 'hi', socketId: handle.socketId })
		api.fire(handle, 'close', { code: 1001, reason: 'gone', wasClean: false })
		await flushMacrotask()

		expect(message).toHaveBeenCalledWith({ data: 'hi' })
		expect(close).toHaveBeenCalledWith({ code: 1001, reason: 'gone' })
	})
})

describe('error 事件异步派发', () => {
	it('error 不在 native 推送的同一个同步栈里回调，下一个宏任务才到达', async () => {
		const handle = api.openConnection()
		const listener = vi.fn()
		handle.task.onError(listener)

		api.fire(handle, 'error', { errMsg: 'boom' })

		expect(listener).not.toHaveBeenCalled()
		await flushMacrotask()
		expect(listener).toHaveBeenCalledWith({ errMsg: 'boom' })
	})
})

describe('Dimina 多连接下的全局 API 路由', () => {
	it('两条连接都存活时，全局 sendSocketMessage 打到最早那条', () => {
		const first = api.openConnection('wss://example.com/first')
		const second = api.openConnection('wss://example.com/second')

		api.sendSocketMessage({ data: 'hi' })

		expect(sendParamsForSocket(first.socketId)).toHaveLength(1)
		expect(sendParamsForSocket(second.socketId)).toHaveLength(0)
	})

	it('旧连接仍存活时新建连接不改绑', () => {
		const first = api.openConnection('wss://example.com/first')
		const later = api.openConnection('wss://example.com/later')

		api.sendSocketMessage({ data: 'hi' })

		expect(sendParamsForSocket(first.socketId)).toHaveLength(1)
		expect(sendParamsForSocket(later.socketId)).toHaveLength(0)
	})

	it('绑定的连接自己关闭后，绑定不会漂移到另一条存活连接', async () => {
		const first = api.openConnection('wss://example.com/first')
		const second = api.openConnection('wss://example.com/second')
		api.fire(first, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fail = vi.fn()

		api.sendSocketMessage({ data: 'hi', fail })

		expect(failResult(fail).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
		expect(sendParamsForSocket(second.socketId)).toHaveLength(0)
	})

	// 多连接时微信只提示全局 API 可能不符合预期，没有公开绑定算法。Dimina 使用最早创建、
	// 尚未终态的连接作为确定性目标；以下只锁定产品行为，不称为微信契约。
	it('停在 CONNECTING 的连接一直占住绑定，全局 sendSocketMessage 不漂到后建的 OPEN 连接上', () => {
		const stuck = api.connect({ url: 'wss://example.com/stuck' })
		const later = api.openConnection('wss://example.com/later')
		const fail = vi.fn()

		api.sendSocketMessage({ data: 'hi', fail })

		expect(failResult(fail).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
		expect(sendParamsForSocket(later.socketId)).toHaveLength(0)
		expect(sendParamsForSocket(stuck.socketId)).toHaveLength(0)
	})

	it('停在 CONNECTING 的连接一直占住绑定，全局 onSocketMessage 收不到后建连接的消息', () => {
		api.connect({ url: 'wss://example.com/stuck' })
		const later = api.openConnection('wss://example.com/later')
		const listener = vi.fn()
		api.onSocketMessage(listener)

		api.fire(later, 'message', { data: 'from-later' })

		expect(listener).not.toHaveBeenCalled()
	})

	it('全局目标仍在握手时 wx.closeSocket 失败，不关闭它或后建任务', () => {
		const stuck = api.connect({ url: 'wss://example.com/stuck' })
		const later = api.openConnection('wss://example.com/later')
		const fail = vi.fn()

		api.closeSocket({ code: 3000, reason: 'bye', fail })

		expect(failResult(fail).errMsg).toBe('closeSocket:fail WebSocket is not connected')
		expect(closeParamsForSocket(stuck.socketId)).toHaveLength(0)
		expect(closeParamsForSocket(later.socketId)).toHaveLength(0)
	})

	it('绑定的连接 CLOSED 之后再 connectSocket 才会改绑到新连接', async () => {
		const first = api.openConnection('wss://example.com/first')
		api.fire(first, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fresh = api.openConnection('wss://example.com/fresh')

		api.sendSocketMessage({ data: 'hi' })

		expect(sendParamsForSocket(fresh.socketId)).toHaveLength(1)
	})
})

describe('全局 wx.onSocket* 是单槽覆盖', () => {
	it('同一事件注册两次时只有最后一个回调被触发', () => {
		const handle = api.openConnection()
		const first = vi.fn()
		const second = vi.fn()

		api.onSocketMessage(first)
		api.onSocketMessage(second)
		api.fire(handle, 'message', { data: 'hi' })

		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledWith({ data: 'hi' })
	})

	it('只派发当前连接的事件，其他并发连接的事件被静默丢弃', () => {
		const current = api.openConnection('wss://example.com/current')
		const other = api.openConnection('wss://example.com/other')
		const listener = vi.fn()
		api.onSocketMessage(listener)

		api.fire(other, 'message', { data: 'from-other' })
		expect(listener).not.toHaveBeenCalled()

		api.fire(current, 'message', { data: 'from-current' })
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith({ data: 'from-current' })
	})

	// 这两条 errMsg 在脚本层没有 fail 通道可派（这个 API 只收一个回调参数），只能验收
	// 可观测的部分：不抛错、返回 undefined、不登记桥回调、单槽里也没被塞进非函数。
	it.each([
		['onSocketOpen', 'open', { header: {} }],
		['onSocketMessage', 'message', { data: 'hi' }],
		['onSocketError', 'error', { errMsg: 'boom' }],
		['onSocketClose', 'close', { code: 1000, reason: '' }],
	])('%s 传非函数时不抛错、返回 undefined、不登记桥回调，也没占住单槽', (name, kind, payload) => {
		const handle = api.openConnection()
		const before = api.bridgeCallCount()

		let returned
		expect(() => {
			returned = api[name](undefined)
		}).not.toThrow()

		expect(returned).toBeUndefined()
		expect(api.bridgeCallCount()).toBe(before)
		// 非函数若被存进单槽，事件到达时调用它会抛 TypeError。
		expect(() => api.fire(handle, kind, payload)).not.toThrow()
	})
})

describe('SocketTask.on* 多监听并存', () => {
	it('多个不同监听都收到事件，同一函数对象重复注册只调用一次', () => {
		const handle = api.openConnection()
		const first = vi.fn()
		const second = vi.fn()

		handle.task.onMessage(first)
		handle.task.onMessage(second)
		handle.task.onMessage(first)
		api.fire(handle, 'message', { data: 'hi' })

		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)
	})
})

describe('wx.closeSocket 按官方公开行为只关闭已打开的全局目标', () => {
	it('全局目标使用调用方的 code/reason，其他 SocketTask 不受影响', () => {
		const current = api.openConnection('wss://example.com/current')
		const other = api.openConnection('wss://example.com/other')

		api.closeSocket({ code: 3000, reason: 'bye' })

		const currentClose = closeParamsForSocket(current.socketId)
		expect(currentClose).toHaveLength(1)
		expect(currentClose[0].code).toBe(3000)
		expect(currentClose[0].reason).toBe('bye')

		expect(closeParamsForSocket(other.socketId)).toHaveLength(0)
	})

	it('关闭已打开的全局目标时，不关闭其他握手中连接', () => {
		const current = api.openConnection('wss://example.com/current')
		const connecting = api.connect({ url: 'wss://example.com/connecting' })

		api.closeSocket({ code: 3000, reason: 'bye' })

		const currentClose = closeParamsForSocket(current.socketId)
		expect(currentClose).toHaveLength(1)
		expect(currentClose[0].code).toBe(3000)
		expect(currentClose[0].reason).toBe('bye')

		expect(closeParamsForSocket(connecting.socketId)).toHaveLength(0)
	})

	it('全局目标已经终态时调用失败，其他 SocketTask 不受影响', async () => {
		const current = api.openConnection('wss://example.com/current')
		const other = api.openConnection('wss://example.com/other')
		api.fire(current, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fail = vi.fn()

		api.closeSocket({ fail })

		expect(failResult(fail).errMsg).toBe('closeSocket:fail WebSocket is not connected')
		expect(closeParamsForSocket(other.socketId)).toHaveLength(0)
	})

	it('一条连接都没有时只发 fail，文案逐字', () => {
		const fail = vi.fn()

		api.closeSocket({ fail })

		expect(failResult(fail).errMsg).toBe('closeSocket:fail WebSocket is not connected')
		expect(api.paramsOf('closeSocket')).toHaveLength(0)
	})
})

describe('wx.sendSocketMessage 只作用于当前连接且要求 OPEN', () => {
	it('当前连接还在 connecting 时走 fail，文案逐字，且不下发 native', () => {
		api.connect({ url: 'wss://example.com' })
		const fail = vi.fn()

		api.sendSocketMessage({ data: 'hi', fail })

		expect(failResult(fail).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
		expect(api.paramsOf('sendSocketMessage')).toHaveLength(0)
	})

	it('一条连接都没有时同样走 fail', () => {
		const fail = vi.fn()

		api.sendSocketMessage({ data: 'hi', fail })

		expect(failResult(fail).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
	})

	it('当前连接 OPEN 时把 data 打到它身上', () => {
		const handle = api.openConnection()

		api.sendSocketMessage({ data: 'hi' })

		const sent = sendParamsForSocket(handle.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('hi')
	})
})
