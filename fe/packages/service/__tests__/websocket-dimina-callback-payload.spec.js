import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

// 共同的收口点都是「脚本层交给业务的回调载荷」：字段全集要收白名单，回调 id 只能由
// 脚本层自己生成。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

// 把一次 closeSocket 下发到桥的那组 settler id 取出来，模拟 native 按 id 回调。
function settlerIdsOfClose(handle) {
	return api.paramsForSocket('closeSocket', handle.socketId)[0]
}

describe('settler 载荷只保留 errMsg', () => {
	// GeneralCallbackResult 只有 errMsg 一个字段。iOS 的 fail 载荷额外带了
	// data:{errMsg}，脚本层不投影就直接漏给业务，三端拿到的 res 形状因此不一样。
	it('native 的 fail 载荷多带字段时，业务侧的 res 键集恰好只有 errMsg', () => {
		const handle = api.openConnection()
		const fail = vi.fn()

		api.closeSocket({ code: 3000, fail })
		api.callback.invoke(settlerIdsOfClose(handle).fail, {
			errMsg: 'closeSocket:fail interrupted',
			data: { errMsg: 'closeSocket:fail interrupted' },
			socketId: handle.socketId,
		})

		const res = fail.mock.calls[0][0]
		expect(Object.keys(res)).toEqual(['errMsg'])
		expect(res.errMsg).toBe('closeSocket:fail interrupted')
	})

	it('native 的 success 载荷多带字段时，业务侧的 res 键集恰好只有 errMsg', () => {
		const handle = api.openConnection()
		const success = vi.fn()

		api.closeSocket({ success })
		api.callback.invoke(settlerIdsOfClose(handle).success, {
			errMsg: 'closeSocket:ok',
			data: { errMsg: 'closeSocket:ok' },
			socketId: handle.socketId,
		})

		const res = success.mock.calls[0][0]
		expect(Object.keys(res)).toEqual(['errMsg'])
		expect(res.errMsg).toBe('closeSocket:ok')
	})

	it('native 的 complete 载荷多带字段时，业务侧的 res 键集恰好只有 errMsg', () => {
		const handle = api.openConnection()
		const complete = vi.fn()

		api.closeSocket({ complete })
		api.callback.invoke(settlerIdsOfClose(handle).complete, {
			errMsg: 'closeSocket:ok',
			data: { errMsg: 'closeSocket:ok' },
			socketId: handle.socketId,
		})

		const res = complete.mock.calls[0][0]
		expect(Object.keys(res)).toEqual(['errMsg'])
		expect(res.errMsg).toBe('closeSocket:ok')
	})

	it('connectSocket 的 fail 载荷同样只保留 errMsg', () => {
		const fail = vi.fn()
		const handle = api.connect({ url: 'wss://example.com', fail })

		api.callback.invoke(handle.params.fail, {
			errMsg: 'connectSocket:fail invalid url',
			data: { errMsg: 'connectSocket:fail invalid url' },
		})

		const res = fail.mock.calls[0][0]
		expect(Object.keys(res)).toEqual(['errMsg'])
		expect(res.errMsg).toBe('connectSocket:fail invalid url')
	})

	it('任务态 SocketTask.close 的 fail 载荷同样只保留 errMsg', () => {
		const handle = api.openConnection()
		const fail = vi.fn()

		handle.task.close({ code: 3000, fail })
		api.callback.invoke(settlerIdsOfClose(handle).fail, {
			errMsg: 'closeSocket:fail invalid code',
			data: { errMsg: 'closeSocket:fail invalid code' },
		})

		const res = fail.mock.calls[0][0]
		expect(Object.keys(res)).toEqual(['errMsg'])
		expect(res.errMsg).toBe('closeSocket:fail invalid code')
	})
})

describe('无 settler 键的 Promise 形态也要投影', () => {
	// settled 路径的投影盖住了，Promise 路径走的是 invokePromiseAPI 的 resolve/reject，
	// 原始载荷原样透传。同一个 API 换个调用形态，业务拿到的 res 形状就变了。
	async function settleOutcome(pending) {
		return pending.then(
			value => ({ kind: 'resolved', value }),
			reason => ({ kind: 'rejected', value: reason }),
		)
	}

	it('closeSocket() 不传 settler 键时，reject 值的键集恰好只有 errMsg', async () => {
		const handle = api.openConnection()

		const pending = api.closeSocket()
		api.callback.invoke(settlerIdsOfClose(handle).fail, {
			errMsg: 'closeSocket:fail interrupted',
			data: { errMsg: 'closeSocket:fail interrupted' },
		})

		const outcome = await settleOutcome(pending)
		expect(outcome.kind).toBe('rejected')
		expect(Object.keys(outcome.value)).toEqual(['errMsg'])
		expect(outcome.value.errMsg).toBe('closeSocket:fail interrupted')
	})

	it('closeSocket() 不传 settler 键时，resolve 值的键集恰好只有 errMsg', async () => {
		const handle = api.openConnection()

		const pending = api.closeSocket()
		api.callback.invoke(settlerIdsOfClose(handle).success, {
			errMsg: 'closeSocket:ok',
			data: { errMsg: 'closeSocket:ok' },
		})

		const outcome = await settleOutcome(pending)
		expect(outcome.kind).toBe('resolved')
		expect(Object.keys(outcome.value)).toEqual(['errMsg'])
	})

	it('sendSocketMessage({data}) 不传 settler 键时，reject 值的键集恰好只有 errMsg', async () => {
		const handle = api.openConnection()

		const pending = api.sendSocketMessage({ data: 'hi' })
		const params = api.paramsForSocket('sendSocketMessage', handle.socketId)[0]
		api.callback.invoke(params.fail, {
			errMsg: 'sendSocketMessage:fail connection closed',
			data: { errMsg: 'sendSocketMessage:fail connection closed' },
		})

		const outcome = await settleOutcome(pending)
		expect(outcome.kind).toBe('rejected')
		expect(Object.keys(outcome.value)).toEqual(['errMsg'])
	})

	it('sendSocketMessage({data}) 不传 settler 键时，resolve 值的键集恰好只有 errMsg', async () => {
		const handle = api.openConnection()

		const pending = api.sendSocketMessage({ data: 'hi' })
		const params = api.paramsForSocket('sendSocketMessage', handle.socketId)[0]
		api.callback.invoke(params.success, {
			errMsg: 'sendSocketMessage:ok',
			data: { errMsg: 'sendSocketMessage:ok' },
		})

		const outcome = await settleOutcome(pending)
		expect(outcome.kind).toBe('resolved')
		expect(Object.keys(outcome.value)).toEqual(['errMsg'])
	})
})

describe('complete 收到的 res 与同一次调用的 success/fail 相同', () => {
	// Android 的 invokeComplete 签名里根本没有结果载荷，complete 拿到 undefined，
	// `wx.closeSocket({complete: res => res.errMsg})` 在那一端直接 TypeError。
	// 脚本层兜住这件事，某端将来再漂也不会漏到业务。
	it('native 只给 success 结果、complete 传 undefined 时，complete 仍拿到同一个 res', () => {
		const handle = api.openConnection()
		const success = vi.fn()
		const complete = vi.fn()

		api.closeSocket({ success, complete })
		const ids = settlerIdsOfClose(handle)
		api.callback.invoke(ids.success, { errMsg: 'closeSocket:ok' })
		api.callback.invoke(ids.complete, undefined)

		expect(complete).toHaveBeenCalledTimes(1)
		expect(complete.mock.calls[0][0]).toEqual(success.mock.calls[0][0])
		expect(complete.mock.calls[0][0]).toEqual({ errMsg: 'closeSocket:ok' })
	})

	it('走 fail 时 complete 拿到的也是同一个 res', () => {
		const handle = api.openConnection()
		const fail = vi.fn()
		const complete = vi.fn()

		api.closeSocket({ fail, complete })
		const ids = settlerIdsOfClose(handle)
		api.callback.invoke(ids.fail, { errMsg: 'closeSocket:fail interrupted' })
		api.callback.invoke(ids.complete, undefined)

		expect(complete).toHaveBeenCalledTimes(1)
		expect(complete.mock.calls[0][0]).toEqual(fail.mock.calls[0][0])
		expect(complete.mock.calls[0][0]).toEqual({ errMsg: 'closeSocket:fail interrupted' })
	})

	it('native 给 complete 传空对象（iOS/Harmony 现状）时也补成同一个 res', () => {
		const handle = api.openConnection()
		const success = vi.fn()
		const complete = vi.fn()

		api.closeSocket({ success, complete })
		const ids = settlerIdsOfClose(handle)
		api.callback.invoke(ids.success, { errMsg: 'closeSocket:ok' })
		api.callback.invoke(ids.complete, {})

		expect(complete.mock.calls[0][0]).toEqual({ errMsg: 'closeSocket:ok' })
	})
})

describe('回调 id 只能由脚本层生成，调用方给的非函数值不得当 id 下发', () => {
	// 探针有效性：真函数会被换成脚本层生成、且本地登记过的 id。没有这条对照，
	// 下面几条只是在比字符串，分不出「正确生成的 id」和「调用方塞进来的字符串」。
	it('探针有效性：传真函数时下发的是脚本层生成并已本地登记的 id', () => {
		const handle = api.openConnection()

		api.closeSocket({ success: vi.fn() })

		const delivered = settlerIdsOfClose(handle).success
		expect(typeof delivered).toBe('string')
		expect(Object.prototype.hasOwnProperty.call(api.callback.callbacks, delivered)).toBe(true)
	})

	it.each([
		['success'],
		['fail'],
		['complete'],
	])('全局 closeSocket 的 %s 传字符串时，那个字符串不得原样成为下发的回调 id', (key) => {
		const handle = api.openConnection()

		api.closeSocket({ [key]: 'forged-callback-id' })

		expect(settlerIdsOfClose(handle)[key]).not.toBe('forged-callback-id')
	})

	// closeSocket 的 fail 只是碰巧被部分完成态回滚那层 wrapper 包成了函数才没漏；判据本身没建立，
	// 没有 wrapper 的 sendSocketMessage 三个键就都漏。这条防止把「fail 现在是绿的」
	// 误当成「fail 这条路已经有判据」。
	it.each([
		['success'],
		['fail'],
		['complete'],
	])('全局 sendSocketMessage 的 %s 传字符串时同样不得当回调 id 下发', (key) => {
		const handle = api.openConnection()

		api.sendSocketMessage({ data: 'hi', [key]: 'forged-callback-id' })

		const params = api.paramsForSocket('sendSocketMessage', handle.socketId)[0]
		expect(params[key]).not.toBe('forged-callback-id')
	})

	// 真正的危害：调用方可以把**别的连接**已登记的回调 id 塞进 settler，native 按 id
	// 触发时打中的是那条连接的业务监听，等于跨连接劫持回调。
	it('不能借非函数 settler 值劫持另一条连接已登记的回调', () => {
		const victim = api.openConnection('wss://example.com/victim')
		const victimHandler = vi.fn()
		victim.task.onMessage(victimHandler)
		const victimMessageId = api.paramsForSocket('onSocketMessage', victim.socketId)[0].callback

		api.closeSocket({ success: victimMessageId })
		// 模拟 native 按下发的 id 回调 success。
		api.callback.invoke(settlerIdsOfClose(victim).success, { data: 'pwned' })

		expect(victimHandler).not.toHaveBeenCalled()
	})

	// 任务态走的是另一条组装路径，本来就用 isFunction 挡住了。留作守门，防止修全局
	// 那条时把两边的判据改反。
	it('任务态 SocketTask.close 的非函数 settler 值本来就不下发', () => {
		const handle = api.openConnection()

		handle.task.close({ success: 'forged-callback-id' })

		expect(settlerIdsOfClose(handle).success).not.toBe('forged-callback-id')
	})
})
