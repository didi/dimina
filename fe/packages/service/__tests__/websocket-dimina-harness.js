import { expect, vi } from 'vitest'

/**
 * Dimina WebSocket 行为测试共用的加载器。
 *
 * 每个用例调用一次 loadSocketApi()：连接注册表、并发计数、全局绑定这些都是模块级状态，
 * 用 vi.resetModules() 拿到全新的模块实例，用例之间才互不污染。@dimina/common 的 callback
 * 表也是同一次 reset 出来的实例，所以事件回调 id 只在本次上下文里有效。
 *
 * 打桩的是最底层的 DiminaServiceBridge，不是 @/api/common：invokeAPI 与 websocket 模块都跑
 * 真实代码，参数从桥上实际收到的报文里读，断言的是真正下发出去的东西。契约里的 fail 文案
 * 全部由脚本层自己产生（校验不通过时压根不下发 native），所以真实 invokeAPI 把 success/fail
 * 换成回调 id 不影响这些断言。
 */

const EVENTS = {
	open: { api: 'onSocketOpen', method: 'onOpen' },
	message: { api: 'onSocketMessage', method: 'onMessage' },
	error: { api: 'onSocketError', method: 'onError' },
	close: { api: 'onSocketClose', method: 'onClose' },
}

export async function loadSocketApi() {
	vi.resetModules()
	globalThis.DiminaServiceBridge = {
		onMessage: null,
		invoke: vi.fn(() => 'invoke-result'),
		publish: vi.fn(() => 'publish-result'),
	}
	const [socket, common] = await Promise.all([
		import('@/api/core/network/websocket/index.js'),
		import('@dimina/common'),
	])
	const { callback } = common
	const bridge = globalThis.DiminaServiceBridge

	function bridgeCallCount() {
		return bridge.invoke.mock.calls.length
	}

	function paramsOf(name) {
		return bridge.invoke.mock.calls
			.filter(call => call[0].body.name === name)
			.map(call => call[0].body.params)
	}

	function lastParamsOf(name) {
		const all = paramsOf(name)
		if (all.length === 0) {
			throw new Error(`bridge never received "${name}"`)
		}
		return all[all.length - 1]
	}

	function paramsForSocket(name, socketId) {
		return paramsOf(name).filter(params => params && params.socketId === socketId)
	}

	/**
	 * 建立一条连接并记住它这次下发的 socketId，后续用它把 native 事件精确投递到这条连接。
	 * 校验失败时 params/socketId 为 undefined。
	 */
	function connect(opts) {
		const before = paramsOf('connectSocket').length
		const task = socket.connectSocket(opts)
		const params = paramsOf('connectSocket')[before]
		return { task, params, socketId: params && params.socketId }
	}

	function callbackIdFor(handle, kind) {
		const hits = paramsForSocket(EVENTS[kind].api, handle.socketId)
			.filter(params => params.callback !== undefined)
		return hits.length ? hits[hits.length - 1].callback : undefined
	}

	/**
	 * 模拟 native 就某条连接推一个事件。
	 *
	 * 判据是「这条连接自己的 socketId 上登记的桥回调」：native 推事件时只知道 socketId，
	 * 脚本层要把同一个事件分给任务态监听和（当它是当前连接时）全局监听。事件注册可能是
	 * 惰性的，所以先挂一个空监听把注册撑起来。
	 */
	function fire(handle, kind, payload) {
		let id = callbackIdFor(handle, kind)
		if (id === undefined) {
			handle.task[EVENTS[kind].method](() => {})
			id = callbackIdFor(handle, kind)
		}
		if (id === undefined) {
			throw new Error(`no bridge callback registered for ${kind} on socket ${handle.socketId}`)
		}
		callback.invoke(id, payload)
	}

	/**
	 * 同 fire，但**不**替调用方补空监听。
	 *
	 * 用来验「连接自身的事实不取决于调用方有没有注册监听器」这类契约：只要 fire 会补一个
	 * 空监听，惰性登记就被测试自己触发了，漏登记的 bug 会被掩盖。找不到桥回调即失败。
	 */
	function fireStrict(handle, kind, payload) {
		const id = callbackIdFor(handle, kind)
		expect(
			id,
			`native ${kind} 事件无处投递：socket ${handle.socketId} 上没有登记 ${EVENTS[kind].api} 桥回调`,
		).toBeDefined()
		callback.invoke(id, payload)
	}

	function openConnection(url = 'wss://example.com') {
		const handle = connect({ url })
		fire(handle, 'open', { header: {} })
		return handle
	}

	return {
		...socket,
		callback,
		bridge,
		bridgeCallCount,
		paramsOf,
		lastParamsOf,
		paramsForSocket,
		connect,
		fire,
		fireStrict,
		openConnection,
	}
}

// 取 fail 回调收到的那个 result；顺带保证它确实只被调用了一次，免得「没调用」的失败被
// 报成读 undefined 的 TypeError。
export function failResult(fail) {
	expect(fail).toHaveBeenCalledTimes(1)
	return fail.mock.calls[0][0]
}

// 微信的 error 事件是 setTimeout(...,0) 派发的；断言前先让宏任务队列跑一轮。
export function flushMacrotask() {
	return new Promise((resolve) => {
		setTimeout(resolve, 0)
	})
}
