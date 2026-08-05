import { invokeAPI } from '@/api/common'
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from '@/api/core/network/socket/shared'
import { callback, isFunction } from '@dimina/common'

// 原生三端收发二进制帧用的是 { data: <base64>, isBuffer: true }，桥上传的是 JSON，
// ArrayBuffer 过不去。出站把 ArrayBuffer / TypedArray 转成 base64 并打上标记，
// 入站再还原成 ArrayBuffer，调用方两侧看到的都是 ArrayBuffer。
function encodeOutgoingData(data) {
	const buffer = toArrayBuffer(data)
	if (!buffer) {
		return { data }
	}
	return { data: arrayBufferToBase64(buffer), isBuffer: true }
}

// data 和 isBuffer 是配套的一对，只能由这里的编码结果决定。调用方在参数里自己带一个
// isBuffer 不能算数：带 true 会让原生把普通文本当 base64 解，带 false 会让二进制帧被
// 当文本原样发出去。所以文本路径要显式把这个字段抹掉，而不是只在二进制路径写 true。
function applyOutgoingData(params, data) {
	const encoded = encodeOutgoingData(data)
	params.data = encoded.data
	if (encoded.isBuffer) {
		params.isBuffer = true
	}
	else {
		delete params.isBuffer
	}
	return params
}

// close code 和 timeout 过桥时是 JSON 里的一个值。三端各自的解析只认宿主原生数字和
// 十进制字符串，而文档承诺的是 JavaScript Number() 的语义——'0xBB8' 就是 3000。转换
// 放在这里做一次，原生收到的一律是数字，不会再出现一端接受、两端拒绝。转不出有限数的
// 原样下发，让原生按自己的文案拒绝，不在脚本层另编一套错误。
function toBridgeNumber(value) {
	if (value === undefined) {
		return value
	}
	if (typeof value === 'number') {
		// JSON 里没有 NaN 和 Infinity，直接下发会被序列化成 null，原生当成没传就
		// 退回默认值。转成字符串下发，原生的十进制规则会照常拒绝。
		return Number.isFinite(value) ? value : String(value)
	}
	const numeric = Number(value)
	return Number.isFinite(numeric) ? numeric : value
}

// header 的值在三端各自用宿主语言的字符串化实现，同一个 {'X-A': [1,2], 'X-B': {a:1}}
// 在 Android 得到 "[1,2]"、"{"a":1}"，在 HarmonyOS 得到 "1,2"、"[object Object]"，
// iOS 又是另一组，服务器收到的握手头随平台而变。这里在下发前用真正的 JS String()
// 统一转好，原生只管名字和 CRLF 的校验。null 和 undefined 直接丢掉，与三端一致。
function normalizeHeader(header) {
	// 数组要原样交给原生。按 Object.keys 遍历会把 ['x'] 改写成 { 0: 'x' }，原生看到的
	// 是合法 object-map，于是接受并发一个名叫 0 的 header；空数组更是被悄悄改成 {}。
	// 三端本来都会以 header must be an object 拒绝它，归一化不能把这道校验绕过去。
	if (!header || typeof header !== 'object' || Array.isArray(header)) {
		return header
	}
	const normalized = {}
	// { 'X-Token': 'a', 'x-token': 'b' } 这种只是大小写不同的键，对 JS 对象来说是两个
	// 不同的属性，会原样一起下发给原生。但 HTTP header 名不分大小写，三端对这种重复
	// 字段名的处理并不一致：Android 用 addHeader，两条都发，等于把同一个字段发了两次；
	// iOS 用 setValue，后写覆盖先写，但遍历的是 Swift Dictionary，迭代顺序不保证，
	// 哪一条生效跨进程运行都可能变；HarmonyOS 只是构造普通对象，两个键也都留着。鉴权、
	// 签名这类 header 一旦撞上就会静默出错。这里在下发前按小写折叠去重，保留第一次出现
	// 的写法和位置，值由最后一个同名字段覆盖，跟 iOS setValue 的语义对齐，且结果是确定的。
	const nameByLowerCase = new Map()
	for (const name of Object.keys(header)) {
		const value = header[name]
		if (value === null || value === undefined) {
			continue
		}
		const lowerName = name.toLowerCase()
		const firstName = nameByLowerCase.get(lowerName) ?? name
		nameByLowerCase.set(lowerName, firstName)
		normalized[firstName] = String(value)
	}
	return normalized
}

function decodeIncomingMessage(value) {
	if (!value || typeof value !== 'object' || !value.isBuffer) {
		return value
	}
	const { isBuffer, ...rest } = value
	return { ...rest, data: base64ToArrayBuffer(value.data) }
}

function createSocketEvent(onName, offName, baseParams = {}) {
	const listeners = new Map()

	function store(listener) {
		// 每个事件使用独立包装函数，避免同一 listener 注册到不同事件时
		// 被全局 callback registry 复用成同一个 id。
		// 二进制帧原生推的是 base64 加 isBuffer 标记，这里还原成 ArrayBuffer 再交给调用方。
		return callback.store(value => listener(decodeIncomingMessage(value)), true)
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
		// 先把注销请求发出去，发成功了再摘本地登记。反过来的话，invokeAPI 同步抛错时原生
		// 那边的监听还在，本地却已经把这个 id 忘了：调用方再也没办法摘掉它，原生后续推来的
		// 事件也会因为登记项没了而派发不出去。
		const result = invokeAPI(offName, { ...baseParams, callback: callbackId, keep: true })
		callback.remove(callbackId)
		return result
	}

	return {
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
				// 抛错时这一句不会执行，listener 仍然留在表里，调用方可以原样重试。
				const result = unregister(callbackId)
				listeners.delete(listener)
				return result
			}

			// 不带 callback 的 off 逐个按 id 摘，不下发一次性清空：清空只让原生把监听扔掉，
			// 本地登记表和全局回调表里的闭包还留着，逐个摘才能三边一起回收。
			// 遍历快照，边摘边删；中途抛错时已经摘掉的不会重复摘，没摘的还留在表里。
			let result
			for (const [registered, callbackId] of [...listeners]) {
				result = unregister(callbackId)
				listeners.delete(registered)
			}
			return result
		},
	}
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/SocketTask.html
 * SocketTask 类，用于管理 WebSocket 连接
 */
class SocketTask {
	constructor(socketId) {
		this.socketId = socketId
		this._events = {
			open: createSocketEvent('onSocketOpen', 'offSocketOpen', { socketId }),
			message: createSocketEvent('onSocketMessage', 'offSocketMessage', { socketId }),
			error: createSocketEvent('onSocketError', 'offSocketError', { socketId }),
			close: createSocketEvent('onSocketClose', 'offSocketClose', { socketId }),
		}
	}

	/**
	 * 通过 WebSocket 连接发送数据
	 * @param {Object} opts 
	 */
	send(opts = {}) {
		const { data, success, fail, complete, ...rest } = opts

		// rest 先展开、脚本层自己生成的字段后写，调用方带同名参数也顶不掉。顺序反过来的话
		// send({ socketId: 别的任务的 id }) 就会把这条消息发到别的连接上。
		const params = applyOutgoingData({
			...rest,
			socketId: this.socketId,
		}, data)

		// 回调直接交给 invokeAPI 注册，不在这里先转成回调 id：转成 id 之后就是普通字符串，
		// invokeAPI 那边只会把它原样带走，success/fail/complete 的成对登记和一次性回收
		// 都走不到。
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

		// 同 send：rest 先展开，socketId 由任务自己决定，close({ socketId: 别的任务 })
		// 不能把别人的连接关掉。
		const params = {
			...rest,
			socketId: this.socketId,
			code: toBridgeNumber(code),
			reason,
		}

		// 同 send：回调直接交给 invokeAPI 注册，success/fail 的成对登记和一次性回收都由它管。
		if (isFunction(success)) {
			params.success = success
		}
		if (isFunction(fail)) {
			params.fail = fail
		}
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

	// 准备参数。rest 先展开：调用方传进来的 socketId 不能顶掉这里生成的那个，否则原生
	// 按调用方的 id 建连接，而返回的 SocketTask 用的是生成的 id，之后 open/message/
	// send/close 全都对不上。
	const params = {
		...rest,
		socketId,
		url,
		header: normalizeHeader(header),
		protocols,
		tcpNoDelay,
		perMessageDeflate,
		timeout: toBridgeNumber(timeout),
		forceCellularNetwork,
	}

	if (isFunction(success)) {
		params.success = success
	}
	if (isFunction(fail)) {
		params.fail = fail
	}
	if (isFunction(complete)) {
		params.complete = complete
	}

	// 调用底层 API
	invokeAPI('connectSocket', params)

	return socketTask
}

/**
 * 通过 WebSocket 连接发送数据（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts 
 */
export function sendSocketMessage(opts) {
	if (!opts || typeof opts !== 'object') {
		return invokeAPI('sendSocketMessage', opts)
	}
	const { data, ...rest } = opts
	return invokeAPI('sendSocketMessage', applyOutgoingData({ ...rest }, data))
}

/**
 * 关闭 WebSocket 连接（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts 
 */
export function closeSocket(opts) {
	if (!opts || typeof opts !== 'object' || opts.code === undefined) {
		return invokeAPI('closeSocket', opts)
	}
	return invokeAPI('closeSocket', { ...opts, code: toBridgeNumber(opts.code) })
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
