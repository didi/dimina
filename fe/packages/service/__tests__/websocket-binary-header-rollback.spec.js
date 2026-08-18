import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

// 这个文件覆盖二进制帧的 base64 互转与保留字段不被调用方顶掉。header 值归一化、close code
// 与 timeout 的语义搬到了 websocket-dimina-*.spec.js。
//
// 每个用例都用 loadSocketApi() 取一份全新的模块实例：连接注册表、全局绑定、并发计数都是
// 模块级状态，上一个用例遗留的连接会一直占住全局绑定并吃掉并发名额。
//
// send 只允许已打开连接，所以要验下发内容先触发 open 事件。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

describe('二进制帧出站：只有官方 ArrayBuffer 会转 base64', () => {
	it.each([
		[[0x01], 'AQ=='],
		[[0x01, 0x02], 'AQI='],
		[[0x01, 0x02, 0x03], 'AQID'],
	])('task.send 把 %j 字节的 ArrayBuffer 转成 %s，并打上 isBuffer:true，不残留原始 ArrayBuffer', (bytes, expectedBase64) => {
		const { task } = api.openConnection()
		const buffer = Uint8Array.from(bytes).buffer

		task.send({ data: buffer })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(expectedBase64)
		expect(params.isBuffer).toBe(true)
		expect(typeof params.data).toBe('string')
	})

	it('task.send 不把非官方 TypedArray 擅自当成 ArrayBuffer', () => {
		const { task } = api.openConnection()
		const view = new Uint8Array([1, 2, 3])

		task.send({ data: view })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(view)
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('task.send 不编码带 byteOffset 的 TypedArray 视图', () => {
		const { task } = api.openConnection()
		// 底层 buffer 4 字节，视图只覆盖中间 [0x01, 0x02] 两字节；如果实现漏掉
		// byteOffset/byteLength，编码出来的会是整段 4 字节，能被这个用例抓到。
		const full = new Uint8Array([0xAA, 0x01, 0x02, 0xFF])
		const view = new Uint8Array(full.buffer, 1, 2)

		task.send({ data: view })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(view)
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('task.send 传字符串时原样下发，不带 isBuffer', () => {
		const { task } = api.openConnection()

		task.send({ data: 'hello' })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('全局 sendSocketMessage 对 ArrayBuffer 的处理跟任务态一致', () => {
		api.openConnection()
		const buffer = Uint8Array.from([1, 2, 3]).buffer

		api.sendSocketMessage({ data: buffer })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('AQID')
		expect(params.isBuffer).toBe(true)
	})

	it('空 ArrayBuffer（0 字节）出站编码成空串，仍带 isBuffer:true', () => {
		const { task } = api.openConnection()

		task.send({ data: new ArrayBuffer(0) })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('')
		expect(params.isBuffer).toBe(true)
	})
})

describe('二进制帧入站：base64 + isBuffer -> ArrayBuffer', () => {
	it('原生推 { data: "AQI=", isBuffer: true }，业务监听收到还原后的 ArrayBuffer，且不残留 isBuffer 字段', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()
		handle.task.onMessage(listener)

		api.fire(handle, 'message', { data: 'AQI=', isBuffer: true })

		expect(listener).toHaveBeenCalledTimes(1)
		const received = listener.mock.calls[0][0]
		expect(Object.prototype.toString.call(received.data)).toBe('[object ArrayBuffer]')
		expect(new Uint8Array(received.data)).toEqual(new Uint8Array([1, 2]))
		expect(received).not.toHaveProperty('isBuffer')
	})

	it('原生推纯文本消息（无 isBuffer）时原样透传，不做任何转换', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()
		handle.task.onMessage(listener)

		api.fire(handle, 'message', { data: 'hello' })

		expect(listener).toHaveBeenCalledWith({ data: 'hello' })
	})

	it('空 base64 串入站还原成 byteLength 为 0 的 ArrayBuffer', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()
		handle.task.onMessage(listener)

		api.fire(handle, 'message', { data: '', isBuffer: true })

		expect(listener).toHaveBeenCalledTimes(1)
		const received = listener.mock.calls[0][0]
		expect(Object.prototype.toString.call(received.data)).toBe('[object ArrayBuffer]')
		expect(received.data.byteLength).toBe(0)
	})
})

describe('connectSocket header 键名不被加工', () => {
	it('键名原样保留，不做 trim', () => {
		api.connect({
			url: 'wss://example.com',
			header: { ' X-Spaced ': 'v' },
		})

		expect(api.lastParamsOf('connectSocket').header).toEqual({ ' X-Spaced ': 'v' })
	})

	it('大小写不同但确实是不同字段时两个都保留', () => {
		api.connect({
			url: 'wss://example.com',
			header: { 'X-A': '1', 'X-B': '2' },
		})

		expect(api.lastParamsOf('connectSocket').header).toEqual({ 'X-A': '1', 'X-B': '2' })
	})
})

describe('保留字段不能被调用方参数顶掉', () => {
	it('send 的 socketId 和 isBuffer 由脚本层决定，调用方同名参数无效', () => {
		const a = api.openConnection('wss://example.com/a')
		const b = api.connect({ url: 'wss://example.com/b' })

		const buffer = new Uint8Array([1, 2]).buffer
		a.task.send({ data: buffer, socketId: b.socketId, isBuffer: false })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.socketId).toBe(a.socketId)
		expect(params.isBuffer).toBe(true)
		expect(params.data).toBe('AQI=')
	})

	it('send 传文本时调用方的 isBuffer:true 不能把它标成二进制', () => {
		const { task } = api.openConnection()

		task.send({ data: 'hello', isBuffer: true })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params.isBuffer).not.toBe(true)
	})

	it('close 的 socketId 只能是本任务的，调用方传别的任务 id 无效', () => {
		const a = api.openConnection('wss://example.com/a')
		const b = api.connect({ url: 'wss://example.com/b' })

		a.task.close({ socketId: b.socketId })

		expect(api.paramsForSocket('closeSocket', a.socketId)).toHaveLength(1)
		expect(api.paramsForSocket('closeSocket', b.socketId)).toHaveLength(0)
	})

	it('connectSocket 用脚本层生成的 socketId，跟返回的 task 及其事件注册一致', () => {
		const { task, socketId } = api.connect({ url: 'wss://example.com', socketId: 'caller-id' })

		expect(socketId).not.toBe('caller-id')
		expect(task.socketId).toBeUndefined()

		// 事件注册也必须走生成的 id，否则原生按调用方的 id 找不到这条连接。
		task.onOpen(vi.fn())
		expect(api.lastParamsOf('onSocketOpen').socketId).toBe(socketId)
	})

	it('全局 sendSocketMessage 打到当前连接，调用方伪造的私有字段一律无效', () => {
		const current = api.openConnection()

		api.sendSocketMessage({ data: 'hello', socketId: 'forged', isBuffer: true, keep: true, evtId: 'forged' })

		const sent = api.paramsForSocket('sendSocketMessage', current.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('hello')
		expect(sent[0]).not.toHaveProperty('isBuffer')
		expect(sent[0]).not.toHaveProperty('keep')
		expect(sent[0]).not.toHaveProperty('evtId')
	})

	it('全局 closeSocket 打到当前连接，不下发调用方伪造的 task/bridge 私有字段', () => {
		const current = api.openConnection()

		api.closeSocket({ code: 1000, reason: 'done', socketId: 'forged', isBuffer: true, keep: true, evtId: 'forged' })

		// closeSocket 会先关当前连接、再遍历关其余，所以按 socketId 定位，不能读最后一次调用。
		const closed = api.paramsForSocket('closeSocket', current.socketId)
		expect(closed).toHaveLength(1)
		expect(closed[0].code).toBe(1000)
		expect(closed[0].reason).toBe('done')
		expect(closed[0]).not.toHaveProperty('isBuffer')
		expect(closed[0]).not.toHaveProperty('keep')
		expect(closed[0]).not.toHaveProperty('evtId')
	})

	it('connectSocket 只下发官方 option 与内部 socketId', () => {
		api.connect({ url: 'wss://example.com', unknown: 'drop', keep: true, evtId: 'forged' })

		const params = api.lastParamsOf('connectSocket')
		expect(params).not.toHaveProperty('unknown')
		expect(params).not.toHaveProperty('keep')
		expect(params).not.toHaveProperty('evtId')
	})
})

describe('出站二进制：视图类型的边界', () => {
	it('DataView 不是官方 ArrayBuffer，不做二进制编码', () => {
		const { task } = api.openConnection()
		const full = new Uint8Array([0xAA, 0x01, 0x02, 0xFF])
		const view = new DataView(full.buffer, 1, 2)

		task.send({ data: view })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(view)
		expect(params).not.toHaveProperty('isBuffer')
	})

	it.runIf(typeof SharedArrayBuffer !== 'undefined')('SharedArrayBuffer 撑起来的 TypedArray 同样不扩展接受', () => {
		const { task } = api.openConnection()
		const shared = new Uint8Array(new SharedArrayBuffer(2))
		shared.set([1, 2])

		task.send({ data: shared })

		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(shared)
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('底层 buffer 已转移的 TypedArray 仍原样交给 native 校验，不冒充 ArrayBuffer', () => {
		const { task } = api.openConnection()
		const buffer = new ArrayBuffer(4)
		const view = new Uint8Array(buffer)
		structuredClone(buffer, { transfer: [buffer] })

		expect(() => task.send({ data: view })).not.toThrow()
		const params = api.lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(view)
		expect(params).not.toHaveProperty('isBuffer')
	})
})
