import { invokeAPI } from '@/api/common'
import { callback, isFunction } from '@dimina/common'

function createSocketEvent(onName, offName, baseParams = {}, internalListener) {
	// 只放调用方注册的监听。维护 readyState 的那个内部监听单独存在 internalId 里，
	// 不进这个表——否则调用方一个不带参数的 off() 会把它一起摘掉。
	const listeners = new Map()
	let internalId = null

	function store(listener) {
		// 每个事件使用独立包装函数，避免同一 listener 注册到不同事件时
		// 被全局 callback registry 复用成同一个 id。
		return callback.store(value => listener(value), true)
	}

	function register(listener) {
		const callbackId = store(listener)
		listeners.set(listener, callbackId)
		try {
			return invokeAPI(onName, { ...baseParams, callback: callbackId, keep: true })
		}
		catch (error) {
			listeners.delete(listener)
			callback.remove(callbackId)
			throw error
		}
	}

	function unregister(callbackId) {
		callback.remove(callbackId)
		return invokeAPI(offName, { ...baseParams, callback: callbackId, keep: true })
	}

	// SocketTask 用它维护 readyState。必须等 connectSocket 发出去之后再装：原生按
	// socketId 找连接再挂监听，连接还没建时这次注册会被直接丢掉。
	function installInternal() {
		if (!isFunction(internalListener) || internalId) {
			return
		}
		const callbackId = store(internalListener)
		internalId = callbackId
		try {
			return invokeAPI(onName, { ...baseParams, callback: callbackId, keep: true })
		}
		catch (error) {
			internalId = null
			callback.remove(callbackId)
			throw error
		}
	}

	return {
		installInternal,
		// 连接进入终态后这些回调不可能再被触发，从全局 registry 里摘掉，
		// 否则每建一条连接就永久留下几个闭包。只动内部这份，调用方自己
		// 注册的监听归调用方管。
		disposeInternal() {
			if (internalId) {
				callback.remove(internalId)
				internalId = null
			}
		},
		on(listener) {
			if (!isFunction(listener) || listeners.has(listener)) {
				return
			}
			return register(listener)
		},
		off(listener) {
			if (isFunction(listener)) {
				const callbackId = listeners.get(listener)
				if (!callbackId) {
					return
				}
				listeners.delete(listener)
				return unregister(callbackId)
			}

			// 不带 callback 的 off 会让原生清空该事件的全部监听，内部那个也在里面；
			// 清空再补回中间有个窗口，事件恰好落在窗口里就永远收不到了。改成逐个按
			// id 摘，内部监听自始至终没动过。
			let result
			for (const callbackId of listeners.values()) {
				result = unregister(callbackId)
			}
			listeners.clear()
			return result
		},
	}
}

/**
 * 把 success / fail 一起登记成回调 id 写进 params，任一条触发时把两条都摘掉。
 *
 * connectSocket 和 close 都需要一个「调用方没传 fail 也要执行」的 fail 包装来维护
 * readyState。但一次调用只会走 success 或 fail 其中一条，回调表只在回调真正触发时
 * 才回收条目，另一条就会永久留下——每成功连接一次、成功关闭一次各漏一个，而且闭包
 * 还捕获着整个 SocketTask。这里成对登记、交叉清理，两边都不会残留。
 *
 * @param {Object} params 会被直接写入 success / fail 两个回调 id
 * @param {Object} opts
 * @param {Function} [opts.success] 调用方传入的 success
 * @param {Function} [opts.fail] 调用方传入的 fail
 * @param {Function} opts.onFail 内部逻辑，先于调用方的 fail 执行
 */
function storePairedSettlers(params, { success, fail, onFail }) {
	let successId
	let failId
	const settle = () => {
		callback.remove(successId)
		callback.remove(failId)
	}

	successId = callback.store((res) => {
		settle()
		if (isFunction(success)) {
			success(res)
		}
	})
	failId = callback.store((error) => {
		settle()
		onFail(error)
		if (isFunction(fail)) {
			fail(error)
		}
	})

	// invokeAPI 对非函数的 success / fail 是原样透传的，所以这里传 id 字符串。
	params.success = successId
	params.fail = failId
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/SocketTask.html
 * SocketTask 类，用于管理 WebSocket 连接
 */
class SocketTask {
	constructor(socketId) {
		this.socketId = socketId
		this._readyState = SocketTask.CONNECTING
		// readyState 跟着真实事件走：连上了才是 OPEN，收到 close 或 error 才是 CLOSED。
		// 不能挂在 connectSocket 的 success 上——那只表示原生受理了这次请求，握手还没完成。
		this._events = {
			open: createSocketEvent('onSocketOpen', 'offSocketOpen', { socketId }, () => {
				this._readyState = SocketTask.OPEN
			}),
			message: createSocketEvent('onSocketMessage', 'offSocketMessage', { socketId }),
			error: createSocketEvent('onSocketError', 'offSocketError', { socketId }, () => {
				this._enterClosed()
			}),
			close: createSocketEvent('onSocketClose', 'offSocketClose', { socketId }, () => {
				this._enterClosed()
			}),
		}
	}

	/**
	 * 装上维护 readyState 的内部监听。由 connectSocket 在下发连接请求之后调用。
	 */
	_installStateListeners() {
		// 原生同步回 fail 时（并发超限、URL 不合法），状态已经落到 CLOSED，
		// 这时候再装监听等于刚摘掉又装回去，白留三个摘不掉的回调。
		if (this._readyState === SocketTask.CLOSED) {
			return
		}
		this._events.open.installInternal()
		this._events.error.installInternal()
		this._events.close.installInternal()
	}

	/**
	 * 连接进入终态：状态落到 CLOSED，同时把维护状态用的内部监听从回调表里摘掉。
	 * 这三个回调之后不可能再被触发，留着就是每条连接永久多占几个闭包。
	 * 只摘内部这份，调用方自己注册的监听不动。
	 */
	_enterClosed() {
		this._readyState = SocketTask.CLOSED
		this._events.open.disposeInternal()
		this._events.error.disposeInternal()
		this._events.close.disposeInternal()
	}

	/**
	 * 通过 WebSocket 连接发送数据
	 * @param {Object} opts 
	 */
	send(opts = {}) {
		const { data, success, fail, complete, ...rest } = opts
		
		const params = {
			socketId: this.socketId,
			data,
			...rest
		}

		// 回调直接交给 invokeAPI 注册：它只把函数形式的 success/fail/complete 转成
		// 回调 id，这里若先自行转成 id，反而会在它那一步被当成非函数丢弃。
		if (isFunction(success)) {
			params.success = success
		}
		if (isFunction(fail)) {
			params.fail = fail
		}
		if (isFunction(complete)) {
			params.complete = complete
		}

		return invokeAPI('sendSocketMessage', params)
	}

	/**
	 * 关闭 WebSocket 连接
	 * @param {Object} opts 
	 */
	close(opts = {}) {
		const { code = 1000, reason = '', success, fail, complete, ...rest } = opts
		
		const params = {
			socketId: this.socketId,
			code,
			reason,
			...rest
		}

		// 已经是终态就别再往回退到 CLOSING。
		const stateBeforeClose = this._readyState
		if (stateBeforeClose !== SocketTask.CLOSED) {
			this._readyState = SocketTask.CLOSING
		}

		// 关闭参数没通过校验时连接其实还开着，把刚才乐观置上的 CLOSING 退回去。
		// 这个 fail 包装总是注册，调用方没传 fail 也要能回退——但一次调用只会走
		// success 或 fail 其中一条，另一条永远不触发也就永远不会被回调表回收，
		// 所以两个 id 自己登记、任一条触发时一起摘掉。
		storePairedSettlers(params, {
			success,
			fail,
			onFail: () => {
				// 只在状态还停在这次 close 置上的 CLOSING 时才回退。远端的 close/error
				// 事件可能已经先到并把状态推到 CLOSED，这时候回退等于把终态倒回去。
				if (this._readyState === SocketTask.CLOSING) {
					this._readyState = stateBeforeClose
				}
			},
		})
		if (isFunction(complete)) {
			params.complete = complete
		}

		return invokeAPI('closeSocket', params)
	}

	/**
	 * 监听 WebSocket 连接打开事件
	 * @param {Function} callback 回调函数
	 */
	onOpen(callbackFn) {
		return this._events.open.on(callbackFn)
	}

	/**
	 * 取消监听 WebSocket 连接打开事件
	 * @param {Function} callback 回调函数
	 */
	offOpen(callbackFn) {
		return this._events.open.off(callbackFn)
	}

	/**
	 * 监听 WebSocket 接受到服务器的消息事件
	 * @param {Function} callback 回调函数
	 */
	onMessage(callbackFn) {
		return this._events.message.on(callbackFn)
	}

	/**
	 * 取消监听 WebSocket 接受到服务器的消息事件
	 * @param {Function} callback 回调函数
	 */
	offMessage(callbackFn) {
		return this._events.message.off(callbackFn)
	}

	/**
	 * 监听 WebSocket 错误事件
	 * @param {Function} callback 回调函数
	 */
	onError(callbackFn) {
		return this._events.error.on(callbackFn)
	}

	/**
	 * 取消监听 WebSocket 错误事件
	 * @param {Function} callback 回调函数
	 */
	offError(callbackFn) {
		return this._events.error.off(callbackFn)
	}

	/**
	 * 监听 WebSocket 连接关闭事件
	 * @param {Function} callback 回调函数
	 */
	onClose(callbackFn) {
		return this._events.close.on(callbackFn)
	}

	/**
	 * 取消监听 WebSocket 连接关闭事件
	 * @param {Function} callback 回调函数
	 */
	offClose(callbackFn) {
		return this._events.close.off(callbackFn)
	}

	/**
	 * 获取 WebSocket 连接状态
	 * @returns {number} 连接状态
	 */
	get readyState() {
		return this._readyState
	}

	/**
	 * WebSocket 的连接状态常量
	 */
	static get CONNECTING() { return 0 }
	static get OPEN() { return 1 }
	static get CLOSING() { return 2 }
	static get CLOSED() { return 3 }
}

const globalSocketEvents = {
	open: createSocketEvent('onSocketOpen', 'offSocketOpen'),
	message: createSocketEvent('onSocketMessage', 'offSocketMessage'),
	error: createSocketEvent('onSocketError', 'offSocketError'),
	close: createSocketEvent('onSocketClose', 'offSocketClose'),
}

/**
 * 创建一个 WebSocket 连接
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/wx.connectSocket.html
 * @param {Object} opts 配置对象
 * @param {string} opts.url 开发者服务器 wss 接口地址
 * @param {Object} [opts.header] HTTP Header，Header 中不能设置 Referer
 * @param {Array<string>} [opts.protocols] 子协议数组
 * @param {boolean} [opts.tcpNoDelay] 建立 TCP 连接的时候的 TCP_NODELAY 设置
 * @param {boolean} [opts.perMessageDeflate] 是否开启压缩扩展
 * @param {number} [opts.timeout] 超时时间，单位为毫秒
 * @param {boolean} [opts.forceCellularNetwork] 强制使用蜂窝网络发送请求
 * @param {Function} [opts.success] 接口调用成功的回调函数
 * @param {Function} [opts.fail] 接口调用失败的回调函数
 * @param {Function} [opts.complete] 接口调用结束的回调函数（调用成功、失败都会执行）
 * @returns {SocketTask} WebSocket 任务对象
 */
export function connectSocket(opts = {}) {
	const { 
		url, 
		header = {}, 
		protocols = [], 
		tcpNoDelay = false, 
		perMessageDeflate = false, 
		timeout, 
		forceCellularNetwork = false,
		success, 
		fail, 
		complete,
		...rest 
	} = opts

	// 验证必填参数
	if (!url) {
		const error = new Error('url is required')
		if (isFunction(fail)) {
			fail(error)
		}
		if (isFunction(complete)) {
			complete(error)
		}
		throw error
	}

	// 生成唯一的 socket ID
	const socketId = `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
	
	// 创建 SocketTask 实例
	const socketTask = new SocketTask(socketId)

	// 准备参数
	const params = {
		socketId,
		url,
		header,
		protocols,
		tcpNoDelay,
		perMessageDeflate,
		timeout,
		forceCellularNetwork,
		...rest
	}

	// success 只代表原生受理了这次连接请求，此时还没握手完成，状态留给 open 事件去改。
	// 连接被拒时不会再有 close 或 error 事件（比如超过并发上限、URL 校验不过），
	// 状态只能在 fail 里落到 CLOSED，维护状态的内部监听也只能在那里摘掉。
	storePairedSettlers(params, {
		success,
		fail,
		onFail: () => socketTask._enterClosed(),
	})
	if (isFunction(complete)) {
		params.complete = complete
	}

	// 调用底层 API
	invokeAPI('connectSocket', params)
	socketTask._installStateListeners()

	return socketTask
}

/**
 * 通过 WebSocket 连接发送数据（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts 
 */
export function sendSocketMessage(opts) {
	return invokeAPI('sendSocketMessage', opts)
}

/**
 * 关闭 WebSocket 连接（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts 
 */
export function closeSocket(opts) {
	return invokeAPI('closeSocket', opts)
}

/**
 * 监听 WebSocket 连接打开事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback 
 */
export function onSocketOpen(callbackFn) {
	return globalSocketEvents.open.on(callbackFn)
}

export function offSocketOpen(callbackFn) {
	return globalSocketEvents.open.off(callbackFn)
}

/**
 * 监听 WebSocket 接受到服务器的消息事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback 
 */
export function onSocketMessage(callbackFn) {
	return globalSocketEvents.message.on(callbackFn)
}

export function offSocketMessage(callbackFn) {
	return globalSocketEvents.message.off(callbackFn)
}

/**
 * 监听 WebSocket 错误事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback 
 */
export function onSocketError(callbackFn) {
	return globalSocketEvents.error.on(callbackFn)
}

export function offSocketError(callbackFn) {
	return globalSocketEvents.error.off(callbackFn)
}

/**
 * 监听 WebSocket 连接关闭事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback 
 */
export function onSocketClose(callbackFn) {
	return globalSocketEvents.close.on(callbackFn)
}

export function offSocketClose(callbackFn) {
	return globalSocketEvents.close.off(callbackFn)
}
