import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failResult, flushMacrotask, loadSocketApi } from './websocket-dimina-harness.js'

// 连接生命周期契约：事件登记时机、终态封存范围、
// 部分完成态回滚。这些洞的共同形状是「连接自身的事实被实现细节绑架」——绑架者要么是
// 「调用方有没有注册监听器」，要么是「终态处理只考虑了一条路径」。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

const EVENT_APIS = ['onSocketOpen', 'onSocketMessage', 'onSocketError', 'onSocketClose']

describe('事件登记不得取决于调用方是否注册监听器', () => {
	it('一个 on* 都没挂的连接，也在 connectSocket 当场登记四个桥回调', () => {
		const handle = api.connect({ url: 'wss://example.com' })

		for (const name of EVENT_APIS) {
			expect(api.paramsForSocket(name, handle.socketId), `${name} 未登记`).toHaveLength(1)
		}
	})

	it('一个 on* 都没挂的连接 open 之后 send 能真正下发，而不是永远 fail', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		api.fireStrict(handle, 'open', { header: {} })
		const fail = vi.fn()

		handle.task.send({ data: 'hello', fail })

		expect(fail).not.toHaveBeenCalled()
		const sent = api.paramsForSocket('sendSocketMessage', handle.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('hello')
	})

	it('一个 on* 都没挂的连接照样计入并发上限', () => {
		for (let index = 0; index < 5; index++) {
			const handle = api.connect({ url: `wss://example.com/${index}` })
			api.fireStrict(handle, 'open', { header: {} })
		}
		const fail = vi.fn()

		api.connectSocket({ url: 'wss://example.com/overflow', fail })

		expect(failResult(fail).errMsg).toBe('connectSocket:fail fail reach max websocket connect count 5')
	})

	it('一个 on* 都没挂的连接终态后归还并发名额', async () => {
		const handles = []
		for (let index = 0; index < 5; index++) {
			const handle = api.connect({ url: `wss://example.com/${index}` })
			api.fireStrict(handle, 'open', { header: {} })
			handles.push(handle)
		}
		api.fireStrict(handles[0], 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com/reuse', fail })

		expect(fail).not.toHaveBeenCalled()
		expect(task).toBeDefined()
	})

	// 同一个洞的另一个入口：登记时机若挂在「connectSocket 那一刻有没有全局监听」上，
	// 先连后注册的调用方一条事件都收不到。
	it('先 connectSocket、后注册 wx.onSocketMessage，照样能收到消息', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()

		api.onSocketMessage(listener)
		api.fireStrict(handle, 'open', { header: {} })
		api.fireStrict(handle, 'message', { data: 'hi' })

		expect(listener).toHaveBeenCalledWith({ data: 'hi' })
	})

	it('先 connectSocket、后注册 wx.onSocketClose，照样能收到关闭', async () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const listener = vi.fn()

		api.onSocketClose(listener)
		api.fireStrict(handle, 'open', { header: {} })
		api.fireStrict(handle, 'close', { code: 1001, reason: 'gone' })
		await flushMacrotask()

		expect(listener).toHaveBeenCalledWith({ code: 1001, reason: 'gone' })
	})
})

describe('error 不吞掉 native 成对下发的 close', () => {
	// 三端 native 对**已 OPEN** 的连接异常失败都是 error → close 双发。error 当刻就把监听
	// 全摘了，业务永远等不到 onClose，重连逻辑挂在 onClose 上的应用会直接卡死。
	it('已 OPEN 的连接收到 error 后，随后的 close 仍送达任务态监听', async () => {
		const handle = api.openConnection()
		const close = vi.fn()
		handle.task.onClose(close)

		api.fire(handle, 'error', { errMsg: 'boom' })
		await flushMacrotask()
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })

		expect(close).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' })
	})

	it('已 OPEN 的连接收到 error 后，随后的 close 仍送达 wx.onSocketClose', async () => {
		const handle = api.openConnection()
		const globalClose = vi.fn()
		api.onSocketClose(globalClose)

		api.fire(handle, 'error', { errMsg: 'boom' })
		await flushMacrotask()
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })

		expect(globalClose).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' })
	})

	it('已 OPEN 的连接 error 之后立即停止发送，不等待 close 事件', async () => {
		const handle = api.openConnection()
		const fail = vi.fn()

		api.fire(handle, 'error', { errMsg: 'boom' })
		await flushMacrotask()
		handle.task.send({ data: 'too late', fail })

		expect(failResult(fail).errMsg).toBe('SocketTask.send:fail WebSocket is not connected')
		expect(api.paramsForSocket('sendSocketMessage', handle.socketId)).toHaveLength(0)
	})

	// 反向用例：从未 open 过的连接（握手就失败）没有成对的 close，此时必须当场封存，
	// 否则四个 keep 回调永远挂在桥上。调整 error/close 派发顺序时不能把这条一起放开。
	it('从未 open 就 error 的连接当场封存，之后不再派发 close', async () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const close = vi.fn()
		handle.task.onClose(close)

		api.fire(handle, 'error', { errMsg: 'handshake failed' })
		await flushMacrotask()
		api.fire(handle, 'close', { code: 1006, reason: '' })

		expect(close).not.toHaveBeenCalled()
	})

	it('从未 open 就 error 的连接封存后，再注册 on* 不往桥上补登记', async () => {
		const handle = api.connect({ url: 'wss://example.com' })
		api.fire(handle, 'error', { errMsg: 'handshake failed' })
		await flushMacrotask()
		const before = api.bridgeCallCount()

		handle.task.onMessage(vi.fn())

		expect(api.bridgeCallCount()).toBe(before)
	})
})

describe('终态事件的相对顺序与 native 下发顺序一致', () => {
	// 三端 native 对已 OPEN 连接的异常失败都是背靠背下发 error → close。脚本层把 error
	// 推进异步队列、close 同步派发，业务实际收到的顺序就反了：重连逻辑在 onClose 里判
	// 「有没有先收到 error」的应用会走错分支。
	//
	// 只锁可观测的先后，不锁实现形状：error 仍可以异步派发，close 也可以异步，
	// 只要两者的相对顺序与 native 下发顺序一致即可。
	it('任务态 onError 先于 onClose 触发', async () => {
		const handle = api.openConnection()
		const order = []
		handle.task.onError(() => order.push('error'))
		handle.task.onClose(() => order.push('close'))

		api.fire(handle, 'error', { errMsg: 'boom' })
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })
		await flushMacrotask()

		expect(order).toEqual(['error', 'close'])
	})

	it('全局 wx.onSocketError 先于 wx.onSocketClose 触发', async () => {
		const handle = api.openConnection()
		const order = []
		api.onSocketError(() => order.push('error'))
		api.onSocketClose(() => order.push('close'))

		api.fire(handle, 'error', { errMsg: 'boom' })
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })
		await flushMacrotask()

		expect(order).toEqual(['error', 'close'])
	})

	it('任务态与全局监听看到的是同一个顺序', async () => {
		const handle = api.openConnection()
		const order = []
		handle.task.onError(() => order.push('task:error'))
		handle.task.onClose(() => order.push('task:close'))
		api.onSocketError(() => order.push('global:error'))
		api.onSocketClose(() => order.push('global:close'))

		api.fire(handle, 'error', { errMsg: 'boom' })
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })
		await flushMacrotask()

		expect(order.indexOf('task:error')).toBeLessThan(order.indexOf('task:close'))
		expect(order.indexOf('global:error')).toBeLessThan(order.indexOf('global:close'))
	})

	// 排队不能变成丢事件或重复派发——这是异步派发的底线。
	it('排队之后 error 与 close 各只送达一次，不丢也不重复', async () => {
		const handle = api.openConnection()
		const error = vi.fn()
		const close = vi.fn()
		handle.task.onError(error)
		handle.task.onClose(close)

		api.fire(handle, 'error', { errMsg: 'boom' })
		api.fire(handle, 'close', { code: 1006, reason: 'abnormal' })
		await flushMacrotask()

		expect(error).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledWith({ errMsg: 'boom' })
		expect(close).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' })
	})
})

describe('事件与内部状态的相对关系（鉴别力复查补洞）', () => {
	// 业务最常见的写法是在 onOpen 里直接 send；内部连接状态必须先于回调切到可发送。
	it('onOpen 回调里可以直接 send', () => {
		const handle = api.connect({ url: 'wss://example.com' })
		const fail = vi.fn()
		handle.task.onOpen(() => {
			handle.task.send({ data: 'from onOpen', fail })
		})

		api.fireStrict(handle, 'open', { header: {} })

		expect(fail).not.toHaveBeenCalled()
		expect(api.paramsForSocket('sendSocketMessage', handle.socketId)).toHaveLength(1)
	})

	// 连接之间的独立性：一条走完终态不能把另一条的事件通路一起带走。
	it('一条连接终态后，另一条连接照样收消息', async () => {
		const a = api.openConnection('wss://example.com/a')
		const b = api.openConnection('wss://example.com/b')
		const bMessage = vi.fn()
		b.task.onMessage(bMessage)

		api.fire(a, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		api.fire(b, 'message', { data: 'still alive' })

		expect(bMessage).toHaveBeenCalledWith({ data: 'still alive' })
	})

	// 并发名额的归还与 close 事件的派发之间也没有锁：业务在 onClose 里重连是标准写法，
	// 如果名额晚于回调归还，重连当场就被并发上限拒掉。
	it('在 onClose 回调里立刻重连，并发名额已经归还', async () => {
		const handles = []
		for (let index = 0; index < 5; index++) {
			handles.push(api.openConnection(`wss://example.com/${index}`))
		}
		const reconnectFail = vi.fn()
		let reconnected
		handles[0].task.onClose(() => {
			reconnected = api.connectSocket({ url: 'wss://example.com/reconnect', fail: reconnectFail })
		})

		api.fire(handles[0], 'close', { code: 1000, reason: '' })
		await flushMacrotask()

		expect(reconnectFail).not.toHaveBeenCalled()
		expect(reconnected).toBeDefined()
	})
})

describe('closeSocket 的部分完成态要回滚', () => {
	// 乐观关闭之后如果 native 拒绝（非法 code、后台 interrupted），传输层其实还开着，
	// 内部状态必须回滚，否则全局 API 会错误地报告 not connected。
	it('回滚之后这条连接重新可用：全局 sendSocketMessage 能打到它', () => {
		const handle = api.openConnection()

		api.closeSocket({ fail: vi.fn() })
		const params = api.paramsForSocket('closeSocket', handle.socketId)[0]
		api.callback.invoke(params.fail, { errMsg: 'closeSocket:fail interrupted' })
		api.sendSocketMessage({ data: 'still here' })

		const sent = api.paramsForSocket('sendSocketMessage', handle.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('still here')
	})

	// 回滚只针对「还没收到终态事件」的连接：close 事件已经到过就是真终态，
	// 迟到的 fail 不得把它复活。
	it('已经收到 close 事件的连接不会被迟到的 closeSocket fail 复活', async () => {
		const handle = api.openConnection()
		const sendFail = vi.fn()

		api.closeSocket({ fail: vi.fn() })
		const params = api.paramsForSocket('closeSocket', handle.socketId)[0]
		api.fire(handle, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		api.callback.invoke(params.fail, { errMsg: 'closeSocket:fail too late' })
		api.sendSocketMessage({ data: 'must stay closed', fail: sendFail })

		expect(failResult(sendFail).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
		expect(api.paramsForSocket('sendSocketMessage', handle.socketId)).toHaveLength(0)
	})
})

describe('超并发返回的 task 必须已封终态', () => {
	function fillConcurrency() {
		for (let index = 0; index < 5; index++) {
			api.openConnection(`wss://example.com/${index}`)
		}
	}

	// native 从未受理过这个 socketId，为它登记 keep 回调等于在桥上挂四条永不回收的订阅。
	it('事后 onError 不再往桥上登记 keep 回调', () => {
		fillConcurrency()
		const task = api.connectSocket({ url: 'wss://example.com/overflow', fail: vi.fn() })
		const before = api.bridgeCallCount()

		task.onError(vi.fn())

		expect(api.bridgeCallCount()).toBe(before)
	})

	it('事后四个 on* 都不往桥上登记 keep 回调', () => {
		fillConcurrency()
		const task = api.connectSocket({ url: 'wss://example.com/overflow', fail: vi.fn() })
		const before = api.bridgeCallCount()

		task.onOpen(vi.fn())
		task.onMessage(vi.fn())
		task.onError(vi.fn())
		task.onClose(vi.fn())

		expect(api.bridgeCallCount()).toBe(before)
	})

})

describe('connectSocket 桥同步抛错：走 fail、返回 undefined、回滚入表与改绑', () => {
	// 同步异常一律不外抛：行为源在 catch 里 `void` 掉整个表达式，调用方拿到的是 undefined
	// 加一次 fail 回调。往外抛会让没有 try/catch 的调用方直接崩在 connectSocket 上。
	function connectWithBrokenBridge(url, fail = vi.fn()) {
		const before = api.paramsOf('connectSocket').length
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'connectSocket') throw new Error('bridge down')
		})
		let task
		expect(() => {
			task = api.connectSocket({ url, fail })
		}).not.toThrow()
		api.bridge.invoke.mockImplementation(() => 'invoke-result')
		return { task, fail, socketId: api.paramsOf('connectSocket')[before].socketId }
	}

	it('桥同步抛错时返回 undefined，不把异常抛给调用方，也不返回半成品 task', () => {
		const { task } = connectWithBrokenBridge('wss://example.com/boom')

		expect(task).toBeUndefined()
	})

	it('桥同步抛错时 fail 的 errMsg 逐字是 connectSocket:fail <异常信息>，且不带 errno', () => {
		const { fail } = connectWithBrokenBridge('wss://example.com/boom')

		const result = failResult(fail)
		expect(result.errMsg).toBe('connectSocket:fail bridge down')
		expect(result).not.toHaveProperty('errno')
	})

	it('抛错的连接不占住全局绑定，后建的连接能接管', () => {
		connectWithBrokenBridge('wss://example.com/boom')
		const fresh = api.openConnection('wss://example.com/fresh')

		api.sendSocketMessage({ data: 'hi' })

		const sent = api.paramsForSocket('sendSocketMessage', fresh.socketId)
		expect(sent).toHaveLength(1)
		expect(sent[0].data).toBe('hi')
	})

	it('抛错的连接不留在注册表里，wx.closeSocket 不会去关一条从未发起的连接', () => {
		const { socketId } = connectWithBrokenBridge('wss://example.com/boom')
		api.openConnection('wss://example.com/fresh')

		api.closeSocket({ fail: vi.fn() })

		expect(api.paramsForSocket('closeSocket', socketId)).toHaveLength(0)
	})
})

describe('反复 connect/close 不让 fe 侧回调表线性累积', () => {
	// 每条连接一建立（不论调用方是否注册监听器）就固定占 4 个 keep 回调，回收全靠终态事件触发本地摘除。
	// 只要漏一条路径，长跑的小程序回调表就会随连接轮次线性涨。
	// 注：这里只能证明**脚本层**回调表不涨，native 侧订阅是否回收在本套件里不可观测。
	function tableSize() {
		return Object.keys(api.callback.callbacks).length
	}

	async function churnOnce(round) {
		const handle = api.connect({ url: `wss://example.com/${round}` })
		// 结掉 connectSocket 自身那对 settler，剩下的增量才只反映事件回调。
		api.callback.invoke(handle.params.success, { errMsg: 'connectSocket:ok' })
		api.fireStrict(handle, 'open', { header: {} })
		api.fireStrict(handle, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
	}

	// 先证明这个探针真的能看见东西：一条存活连接会在表里占住四个事件回调。少了这条，
	// 下面的「不增长」断言可能只是在比较两个恒为 0 的数，泄漏了也照样绿。
	it('探针有效性：一条存活连接在回调表里占住四个事件回调，终态后归零', async () => {
		const baseline = tableSize()
		const handle = api.connect({ url: 'wss://example.com/live' })
		api.callback.invoke(handle.params.success, { errMsg: 'connectSocket:ok' })

		expect(tableSize()).toBe(baseline + 4)

		api.fireStrict(handle, 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		expect(tableSize()).toBe(baseline)
	})

	it('connect → open → close 跑十轮，回调表条目数不随轮次增长', async () => {
		await churnOnce(0)
		const afterFirst = tableSize()

		for (let round = 1; round < 10; round++) {
			await churnOnce(round)
		}

		expect(tableSize()).toBe(afterFirst)
	})

	it('connect → open → error（已 OPEN 的异常路径）跑十轮同样不增长', async () => {
		async function churnByError(round) {
			const handle = api.connect({ url: `wss://example.com/err-${round}` })
			api.callback.invoke(handle.params.success, { errMsg: 'connectSocket:ok' })
			api.fireStrict(handle, 'open', { header: {} })
			api.fireStrict(handle, 'error', { errMsg: 'boom' })
			await flushMacrotask()
			api.fireStrict(handle, 'close', { code: 1006, reason: '' })
		}

		await churnByError(0)
		const afterFirst = tableSize()

		for (let round = 1; round < 10; round++) {
			await churnByError(round)
		}

		expect(tableSize()).toBe(afterFirst)
	})
})
