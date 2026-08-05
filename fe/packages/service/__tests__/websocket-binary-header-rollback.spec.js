import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { closeSocket, connectSocket, sendSocketMessage } from '../src/api/core/network/websocket/index.js'

// 这个文件跟 websocket-events.spec.js 用同一套 mock 方式（整体打桩 @/api/common 的
// invokeAPI），但覆盖的是另外几块互不相关的契约：二进制帧的 base64 互转、header 值的
// 字符串化、保留字段不被调用方顶掉、close code 与 timeout 的下发语义。放进单独文件
// 是因为它们跟 websocket-events.spec.js 里「事件注册表 / off() 回滚」的关注点不同，
// 混在一起会让那个文件的分组注释（需求一/需求二）名不副实。

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

function bytesToBase64(bytes) {
	// 用 Node 自带的 Buffer 作为独立的 base64 参照实现，不复用被测模块内部手写的
	// base64 编码逻辑，避免测试和实现共用同一套算法、算错了也测不出来。
	return Buffer.from(bytes).toString('base64')
}

describe('二进制帧出站：ArrayBuffer / TypedArray -> base64', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it.each([
		[[0x01], 'AQ=='],
		[[0x01, 0x02], 'AQI='],
		[[0x01, 0x02, 0x03], 'AQID'],
	])('task.send 把 %j 字节的 ArrayBuffer 转成 %s，并打上 isBuffer:true，不残留原始 ArrayBuffer', (bytes, expectedBase64) => {
		const task = connectSocket({ url: 'wss://example.com' })
		const buffer = Uint8Array.from(bytes).buffer

		task.send({ data: buffer })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(expectedBase64)
		expect(params.isBuffer).toBe(true)
		expect(typeof params.data).toBe('string')
	})

	it('task.send 正确转换 TypedArray（整段覆盖）', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const view = new Uint8Array([1, 2, 3])

		task.send({ data: view })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(bytesToBase64([1, 2, 3]))
		expect(params.isBuffer).toBe(true)
	})

	it('task.send 正确转换带 byteOffset 的 TypedArray 视图，只取视图覆盖的那一段', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		// 底层 buffer 4 字节，视图只覆盖中间 [0x01, 0x02] 两字节；如果实现漏掉
		// byteOffset/byteLength，编码出来的会是整段 4 字节，能被这个用例抓到。
		const full = new Uint8Array([0xAA, 0x01, 0x02, 0xFF])
		const view = new Uint8Array(full.buffer, 1, 2)

		task.send({ data: view })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(bytesToBase64([0x01, 0x02]))
		expect(params.isBuffer).toBe(true)
	})

	it('task.send 传字符串时原样下发，不带 isBuffer', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.send({ data: 'hello' })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params).not.toHaveProperty('isBuffer')
	})

	it('全局 sendSocketMessage 对 ArrayBuffer 的处理跟任务态一致', () => {
		const buffer = Uint8Array.from([1, 2, 3]).buffer

		sendSocketMessage({ data: buffer })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('AQID')
		expect(params.isBuffer).toBe(true)
	})

	it('空 ArrayBuffer（0 字节）出站编码成空串，仍带 isBuffer:true', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.send({ data: new ArrayBuffer(0) })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('')
		expect(params.isBuffer).toBe(true)
	})
})

describe('二进制帧入站：base64 + isBuffer -> ArrayBuffer', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('原生推 { data: "AQI=", isBuffer: true }，业务监听收到还原后的 ArrayBuffer，且不残留 isBuffer 字段', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onMessage(listener)
		const messageCallbackId = lastParamsOf('onSocketMessage').callback

		callback.invoke(messageCallbackId, { data: 'AQI=', isBuffer: true })

		expect(listener).toHaveBeenCalledTimes(1)
		const received = listener.mock.calls[0][0]
		expect(Object.prototype.toString.call(received.data)).toBe('[object ArrayBuffer]')
		expect(new Uint8Array(received.data)).toEqual(new Uint8Array([1, 2]))
		expect(received).not.toHaveProperty('isBuffer')
	})

	it('原生推纯文本消息（无 isBuffer）时原样透传，不做任何转换', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onMessage(listener)
		const messageCallbackId = lastParamsOf('onSocketMessage').callback

		callback.invoke(messageCallbackId, { data: 'hello' })

		expect(listener).toHaveBeenCalledWith({ data: 'hello' })
	})

	it('空 base64 串入站还原成 byteLength 为 0 的 ArrayBuffer', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const listener = vi.fn()
		task.onMessage(listener)
		const messageCallbackId = lastParamsOf('onSocketMessage').callback

		callback.invoke(messageCallbackId, { data: '', isBuffer: true })

		expect(listener).toHaveBeenCalledTimes(1)
		const received = listener.mock.calls[0][0]
		expect(Object.prototype.toString.call(received.data)).toBe('[object ArrayBuffer]')
		expect(received.data.byteLength).toBe(0)
	})
})

describe('connectSocket header 值归一化', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('数组、对象、数字、布尔都用 JavaScript String() 转成字符串', () => {
		connectSocket({
			url: 'wss://example.com',
			header: {
				'X-Arr': [1, 2],
				'X-Obj': { a: 1 },
				'X-Num': 1,
				'X-Bool': true,
			},
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({
			'X-Arr': '1,2',
			'X-Obj': '[object Object]',
			'X-Num': '1',
			'X-Bool': 'true',
		})
	})

	it('值为 null 或 undefined 的键被丢掉，不出现在下发的 header 里', () => {
		connectSocket({
			url: 'wss://example.com',
			header: {
				'X-Keep': 'v',
				'X-Null': null,
				'X-Undef': undefined,
			},
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ 'X-Keep': 'v' })
		expect(params.header).not.toHaveProperty('X-Null')
		expect(params.header).not.toHaveProperty('X-Undef')
	})

	it('键名原样保留，不做 trim', () => {
		connectSocket({
			url: 'wss://example.com',
			header: { ' X-Spaced ': 'v' },
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ ' X-Spaced ': 'v' })
	})

	it('不传 header 时下发的仍是默认空对象，不报错', () => {
		expect(() => connectSocket({ url: 'wss://example.com' })).not.toThrow()

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({})
	})

	// 三端 validator 都要求 header 是 object-map，数组会被拒。归一化如果按 Object.keys
	// 遍历，['x'] 会变成 { 0: 'x' }，原生看到的是合法 map，于是接受并发一个名叫 0 的
	// header；空数组则被悄悄改成 {}。数组必须原样下发，让原生按自己的错误串拒绝。
	it.each([
		[['x']],
		[[]],
	])('顶层 header 传数组 %j 时原样下发，不被改写成对象', (header) => {
		connectSocket({ url: 'wss://example.com', header })

		const params = lastParamsOf('connectSocket')
		expect(Array.isArray(params.header)).toBe(true)
		expect(params.header).toEqual(header)
	})

	// 三端对「只是大小写不同的同名字段」处理不一致：Android 两条都发等于发了两次同一个
	// 字段，iOS 后写覆盖先写但遍历顺序不保证，HarmonyOS 两个键都留着。鉴权、签名类
	// header 撞上就会静默出错，归一化要把它们折叠成一个，值取最后一个，写法和位置用第一个。
	it('同名不同大小写的 header 折叠成一个键，用首次出现的写法，值是最后一个', () => {
		connectSocket({
			url: 'wss://example.com',
			header: { 'X-Token': 'a', 'x-token': 'b' },
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ 'X-Token': 'b' })
	})

	it('三个及以上同名不同大小写的 header 同样只剩一个键，值是最后一个', () => {
		connectSocket({
			url: 'wss://example.com',
			header: { 'X-Token': 'a', 'X-TOKEN': 'b', 'x-token': 'c' },
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ 'X-Token': 'c' })
	})

	it('同名字段里后一个的值是 null 时被丢掉，前一个保留，不能因为后者是 null 就把整个字段抹掉', () => {
		connectSocket({
			url: 'wss://example.com',
			header: { 'X-Token': 'a', 'x-token': null },
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ 'X-Token': 'a' })
	})

	it('大小写不同但确实是不同字段时不受折叠影响，两个都保留', () => {
		connectSocket({
			url: 'wss://example.com',
			header: { 'X-A': '1', 'X-B': '2' },
		})

		const params = lastParamsOf('connectSocket')
		expect(params.header).toEqual({ 'X-A': '1', 'X-B': '2' })
	})
})

describe('保留字段不能被调用方参数顶掉', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('send 的 socketId 和 isBuffer 由脚本层决定，调用方同名参数无效', () => {
		const taskA = connectSocket({ url: 'wss://example.com/a' })
		const taskB = connectSocket({ url: 'wss://example.com/b' })

		taskA.send({ data: new Uint8Array([1, 2]), socketId: taskB.socketId, isBuffer: false })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.socketId).toBe(taskA.socketId)
		expect(params.isBuffer).toBe(true)
		expect(params.data).toBe('AQI=')
	})

	it('send 传文本时调用方的 isBuffer:true 不能把它标成二进制', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.send({ data: 'hello', isBuffer: true })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params.isBuffer).not.toBe(true)
	})

	it('close 的 socketId 只能是本任务的，调用方传别的任务 id 无效', () => {
		const taskA = connectSocket({ url: 'wss://example.com/a' })
		const taskB = connectSocket({ url: 'wss://example.com/b' })

		taskA.close({ socketId: taskB.socketId })

		const params = lastParamsOf('closeSocket')
		expect(params.socketId).toBe(taskA.socketId)
	})

	it('connectSocket 用脚本层生成的 socketId，跟返回的 task 及其事件注册一致', () => {
		const task = connectSocket({ url: 'wss://example.com', socketId: 'caller-id' })

		const params = lastParamsOf('connectSocket')
		expect(params.socketId).not.toBe('caller-id')
		expect(params.socketId).toBe(task.socketId)

		// 事件注册也必须走生成的 id，否则原生按调用方的 id 找不到这条连接。
		task.onOpen(vi.fn())
		expect(lastParamsOf('onSocketOpen').socketId).toBe(task.socketId)
	})

	it('全局 sendSocketMessage 传文本时调用方的 isBuffer:true 同样无效', () => {
		sendSocketMessage({ data: 'hello', isBuffer: true })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('hello')
		expect(params.isBuffer).not.toBe(true)
	})
})

describe('close code / timeout 按 JavaScript Number 语义下发', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	// 三端各自的解析只认十进制串，而文档承诺的是 Number() 的语义。转换放在脚本层做一次，
	// 原生收到的就是数字，三端不会再出现一端接受两端拒绝。
	it.each([
		['3000', 3000],
		['0xBB8', 3000],
		[' 3000 ', 3000],
		[3000, 3000],
	])('task.close 的 code %j 下发成数字 %j', (code, expected) => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.close({ code })

		expect(lastParamsOf('closeSocket').code).toBe(expected)
	})

	it('task.close 的 code 转不出有限数时原样下发，由原生报错', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.close({ code: {} })

		expect(lastParamsOf('closeSocket').code).toEqual({})
	})

	it('全局 closeSocket 的 code 也走同一套转换', () => {
		closeSocket({ code: '0xBB8' })

		expect(lastParamsOf('closeSocket').code).toBe(3000)
	})

	it.each([
		['0x10', 16],
		['16', 16],
		[[], 0],
		[[16], 16],
	])('connectSocket 的 timeout %j 下发成数字 %j', (timeout, expected) => {
		connectSocket({ url: 'wss://example.com', timeout })

		expect(lastParamsOf('connectSocket').timeout).toBe(expected)
	})

	it('connectSocket 的 timeout 转不出有限数时原样下发', () => {
		connectSocket({ url: 'wss://example.com', timeout: {} })

		expect(lastParamsOf('connectSocket').timeout).toEqual({})
	})

	it('不传 timeout 时不会被转成 0，仍是 undefined', () => {
		connectSocket({ url: 'wss://example.com' })

		expect(lastParamsOf('connectSocket').timeout).toBeUndefined()
	})

	// 桥用 JSON 序列化，JSON 里没有 NaN/Infinity，这两个值原样下发会被序列化成 null，
	// 三端原生把 null 当成没传、悄悄退回默认值（如 close code 退回 1000）。这里用
	// JSON.parse(JSON.stringify(...)) 真正走一遍序列化，只看 mock 到的原始 params 对象
	// 抓不出这个问题——转换前后 params.code 都是 typeof number 的 NaN，序列化之后才现形。
	it('task.close 的 code 传 NaN 时，过一遍 JSON 序列化也不会变成 null', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.close({ code: Number.NaN })

		const params = lastParamsOf('closeSocket')
		const serialized = JSON.parse(JSON.stringify(params))
		expect(serialized.code).toBe('NaN')
	})

	it('connectSocket 的 timeout 传 Infinity 时，过一遍 JSON 序列化也不会变成 null', () => {
		connectSocket({ url: 'wss://example.com', timeout: Number.POSITIVE_INFINITY })

		const params = lastParamsOf('connectSocket')
		const serialized = JSON.parse(JSON.stringify(params))
		expect(serialized.timeout).toBe('Infinity')
	})

	// code 为 null 时，close(opts) 的解构默认值 `{ code = 1000 }` 只对 undefined 生效，
	// null 会穿过去被当成「调用方传了 code」。文档承诺的是 Number() 语义，Number(null)
	// 是 0，0 不在合法关闭码集合里，应该让原生按自己的文案拒绝，而不是悄悄退回 1000。
	it('task.close 的 code 传 null 时下发的是 0，不是默认值 1000', () => {
		const task = connectSocket({ url: 'wss://example.com' })

		task.close({ code: null })

		expect(lastParamsOf('closeSocket').code).toBe(0)
	})
})

describe('出站二进制：视图类型的边界', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('DataView 按视图覆盖的那一段编码', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const full = new Uint8Array([0xAA, 0x01, 0x02, 0xFF])
		const view = new DataView(full.buffer, 1, 2)

		task.send({ data: view })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe(bytesToBase64([0x01, 0x02]))
		expect(params.isBuffer).toBe(true)
	})

	// SharedArrayBuffer 撑起来的 TypedArray 在 ArrayBuffer.isView 的语义下同样是
	// TypedArray，文档承诺的也是「TypedArray」。按 buffer 的 brand 判定会把它漏掉，
	// 视图被当普通对象过桥，原生只能报 data must be string or ArrayBuffer。
	it.runIf(typeof SharedArrayBuffer !== 'undefined')('SharedArrayBuffer 撑起来的 TypedArray 也能编码', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const shared = new Uint8Array(new SharedArrayBuffer(2))
		shared.set([1, 2])

		task.send({ data: shared })

		const params = lastParamsOf('sendSocketMessage')
		expect(params.data).toBe('AQI=')
		expect(params.isBuffer).toBe(true)
	})

	it('底层 buffer 已经被转移走的视图同步报错，不会被当成文本发出去', () => {
		const task = connectSocket({ url: 'wss://example.com' })
		const buffer = new ArrayBuffer(4)
		const view = new Uint8Array(buffer)
		structuredClone(buffer, { transfer: [buffer] })

		expect(() => task.send({ data: view })).toThrow()
		expect(paramsOfAll('sendSocketMessage')).toHaveLength(0)
	})
})
