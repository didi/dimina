import { invokeAPI, invokeAPIWithoutPromise } from '@/api/common'
import { arrayBufferToBase64, base64ToArrayBuffer } from '@/api/core/network/socket/shared'
import { invokeSafelyAll } from '@/core/safe-callback'
import { callback, isFunction } from '@dimina/common'

// 连接状态只保存在 SocketTask 的私有状态中。微信公开文档和官方类型定义没有声明
// readyState 或 CONNECTING/OPEN/CLOSING/CLOSED，不能把内部状态提升成公开 API。
const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

// 官方规定每个小程序最多同时存在 5 条 WebSocket 连接。握手中、已打开和正在关闭但尚未
// 收到终态事件的连接都属于“同时存在”，共同占用名额。
const MAX_CONNECT_COUNT = 5

// 微信公开网络规则要求 WebSocket 使用 wss。主机、fragment 和非法字符等细化校验继续
// 交给三端 native；服务器域名白名单由宿主生产网络策略另行实现。
const WEBSOCKET_URL = /^wss:\/\/.*/i

// 事件 payload 的字段全集。内部字段（socketId、isBuffer、state、errCode）与 W3C 才有的
// wasClean 都在这里被挡住，不进业务回调。
const TASK_EVENT_FIELDS = {
	open: ['header', 'profile'],
	message: ['data'],
	error: ['errMsg'],
	close: ['code', 'reason'],
}

// 全局 wx.onSocketOpen 只有 header，没有 profile；其余三个事件与任务态共用同一份投影。
const GLOBAL_EVENT_FIELDS = {
	...TASK_EVENT_FIELDS,
	open: ['header'],
}

// 原生三端收发二进制帧用的是 { data: <base64>, isBuffer: true }，桥上传的是 JSON，
// ArrayBuffer 过不去。出站把 ArrayBuffer 转成 base64 并打上标记，
// 入站再还原成 ArrayBuffer，调用方两侧看到的都是 ArrayBuffer。
function encodeOutgoingData(data) {
	// WebSocket 的 data 只接受 string | ArrayBuffer；TypedArray/DataView 即使底层
	// 也引用 ArrayBuffer，也不是这个 API 的合法输入，不能擅自扩成浏览器 WebSocket 语义。
	if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]') {
		return { data }
	}
	return { data: arrayBufferToBase64(data), isBuffer: true }
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

// header 的值在三端各自用宿主语言的字符串化实现，同一个 {'X-A': [1,2], 'X-B': {a:1}}
// 在各端得到的结果都不一样。这里在下发前统一归一化：string 原样保留，number 转成字符串，
// 其余一切类型取 Object.prototype.toString 的结果（'[object Array]'、'[object Null]' 等）。
// 键名不做任何加工：大小写不同的两个键是两个字段，不折叠、不去重、不 trim。
function normalizeHeader(header) {
	// 无原型：普通对象上写 `__proto__` 会打到继承的 setter，那个 header 既不报错也不落成
	// 自有字段，直接消失。header 常常来自服务端下发的 JSON，`JSON.parse` 造出来的正是
	// 自有的 `__proto__` 键，用 `{}` 接就会静默丢掉它。
	const normalized = Object.create(null)
	for (const name of Object.keys(header)) {
		const value = header[name]
		if (typeof value === 'string') {
			normalized[name] = value
		}
		else if (typeof value === 'number') {
			normalized[name] = String(value)
		}
		else {
			normalized[name] = Object.prototype.toString.apply(value)
		}
	}
	return normalized
}

// 事件 payload 只保留字段全集里列出的键，且只保留原生真的推了的那些。
function projectEvent(value, fields) {
	const result = {}
	if (!value || typeof value !== 'object') {
		return result
	}
	for (const field of fields) {
		if (field in value) {
			result[field] = value[field]
		}
	}
	return result
}

// 二进制帧原生推的是 base64 加 isBuffer 标记，还原成 ArrayBuffer 再交给调用方。
function decodeIncomingMessage(value) {
	const projected = projectEvent(value, TASK_EVENT_FIELDS.message)
	if (value && typeof value === 'object' && value.isBuffer) {
		projected.data = base64ToArrayBuffer(value.data)
	}
	return projected
}

// code 与 timeout 都用 Number.isFinite 判：非 Number 与 NaN/Infinity 一律归一化。
// 微信只查 typeof（NaN 原样下发），但 dimina 的桥上这条规则做不到三端同构——JSON 桥把
// NaN 变成 null（被当成没传、回落默认值），JSValue 桥原样保留（命中 invalid 校验被拒），
// 同一份代码两端结局相反。三端同构优先于逐字复刻。
function normalizeCloseCode(code) {
	return Number.isFinite(code) ? code : 1000
}

// 非有限数、以及小于 1ms 的值都归 0 后透传：0.5ms 这类值在 native 取整后是 0，却因为
// 原始值大于 0 被当成「调用方指定了超时」，结果排了个 0ms 的截止，连拨号都没发生。
// app.json 与 60000 的回落链全部在 native，脚本层不读配置也不起定时器。
function normalizeTimeout(timeout) {
	return Number.isFinite(timeout) && timeout >= 1 ? timeout : 0
}

// parameter error 文案里的类型名，与 Object.prototype.toString 的 brand 一致：
// undefined 报 Undefined、123 报 Number。
function typeNameOf(value) {
	return Object.prototype.toString.call(value).slice(8, -1)
}

function isSettlerObject(value) {
	return Boolean(value) && typeof value === 'object'
}

// Promise 分支的判据是「参数对象上有没有 success/fail/complete 这个键」，不是「值是不是
// 函数」：{ success: undefined } 也算调用方选择了回调形态，返回 void。
function hasSettlerKey(options) {
	return Object.prototype.hasOwnProperty.call(options, 'success')
		|| Object.prototype.hasOwnProperty.call(options, 'fail')
		|| Object.prototype.hasOwnProperty.call(options, 'complete')
}

// 脚本层自己产生的 fail：校验没过就不下发 native，直接把只含 errMsg 的
// GeneralCallbackResult 交给调用方的 fail / complete。
function settleFailure(options, result) {
	if (isFunction(options.fail)) {
		options.fail(result)
	}
	if (isFunction(options.complete)) {
		options.complete(result)
	}
}

// success / fail / complete 三个回调的 res 都是 GeneralCallbackResult，只有 errMsg。
// 三端现状各带各的私货（iOS 的 data:{errMsg}、内部 socketId），在这里统一收口，
// 省得逐端补且哪端漏了都看不出来。
function projectSettlerResult(result) {
	return projectEvent(result, ['errMsg'])
}

/**
 * 一次 API 调用的 settler 投影。
 *
 * 除了收字段白名单，还负责 complete 的载荷：complete 必须拿到与同一次调用的
 * success / fail 逐字相同的 res。三端给 complete 的东西并不一致（一端 undefined、
 * 一端空对象），脚本层记下先到的那条判决结果，complete 一律用它。
 */
function createSettlerProjection() {
	let settledResult

	function settle(result) {
		settledResult = projectSettlerResult(result)
		return settledResult
	}

	return {
		settle,
		wrap(key, callback) {
			if (key === 'complete') {
				return result => callback(settledResult ?? settle(result))
			}
			return result => callback(settle(result))
		},
	}
}

// 回调包一层后直接交给 invokeAPI 注册，不在这里先转成回调 id：转成 id 之后就是普通
// 字符串，invokeAPI 那边只会把它原样带走，success/fail/complete 的成对登记和一次性
// 回收都走不到。非函数值一概不下发。
function attachSettlers(params, options, projection) {
	for (const key of ['success', 'fail', 'complete']) {
		if (isFunction(options[key])) {
			params[key] = projection.wrap(key, options[key])
		}
	}
}

// 已发起且尚未终态的连接。握手中、已打开和关闭握手中的连接都在这里，既用于严格执行
// 5 条连接上限，也确保终态或前置失败时统一归还名额。
const startedTasks = new Set()
// 全局 wx.* 接口的内部绑定目标。多连接下的绑定细节未由微信公开文档定义，属于 Dimina
// 的确定性路由行为，不作为微信公开契约。
let boundTask
// wx.onSocketXxx 是单槽覆盖，同名事件只保留最后一次注册的回调。
const globalListeners = { open: undefined, message: undefined, error: undefined, close: undefined }

/**
 * 事件送达业务的唯一出口，保证「送达顺序 = native 下发顺序」。
 *
 * 桥本身是一条有序通道，native 对异常失败的连接是背靠背下发 error → close。但 error 必须
 * 推迟到下一个宏任务才派发（connectSocket 要来得及先返回、调用方要来得及注册 onError），
 * 若别的事件仍走同步派发，它就会插到还没派发的 error 前面，业务先收到 onClose 再收到
 * onError。所以所有事件共用这一条 FIFO：队列空时直接派发，队列非空就排到队尾，任何事件
 * 都不会越过比它早到的事件。
 */
const eventDispatchQueue = []
let eventDispatchScheduled = false

function drainEventDispatchQueue() {
	eventDispatchScheduled = false
	// 先整体取走：派发过程中新入队的（比如 onClose 里又 connect 再关）留到下一轮，
	// 既不会插队，也不会被这一轮的循环漏掉。
	const pending = eventDispatchQueue.splice(0, eventDispatchQueue.length)
	for (const dispatch of pending) {
		dispatch()
	}
}

function deliverInOrder(dispatch, { defer = false } = {}) {
	if (!defer && eventDispatchQueue.length === 0) {
		dispatch()
		return
	}
	eventDispatchQueue.push(dispatch)
	if (eventDispatchScheduled) {
		return
	}
	eventDispatchScheduled = true
	setTimeout(drainEventDispatchQueue, 0)
}

// 只有「当前连接」的事件才回调全局监听，其他并发连接的事件静默丢弃。
function deliverGlobalEvent(isBound, name, value) {
	const listener = globalListeners[name]
	if (!isBound || !isFunction(listener)) {
		return
	}
	const result = name === 'message' ? value : projectEvent(value, GLOBAL_EVENT_FIELDS[name])
	invokeSafelyAll(undefined, [listener], [result], `wx.onSocket-${name}`, false)
}

// SocketTask 对外没有 off*，但内部 callback registry 仍必须在连接终态时回收。任务态每个
// 事件只登记一个 bridge callback，这个 callback 在脚本层按注册顺序扇出给所有业务监听；
// 终态时统一 seal，移除四个 keep callback，避免只能靠非标准 off* 才能释放。终态的判定
// 见 error / close 两个处理器：close 一定封存，error 只在这条连接从未 open 时封存。
function createTaskSocketEvent(onName, offName, baseParams, emit) {
	const listeners = new Set()
	let callbackId
	let sealed = false

	function deactivate(notifyNative) {
		if (!callbackId) return
		const currentId = callbackId
		if (notifyNative) {
			// off 桥自己抛错时 native 仍持有这个 id，本地登记要留着让终态那次 seal 去摘；
			// 在这里先清本地，就会留下一个再也无法管理的 native/registry 悬挂监听。
			invokeAPI(offName, { ...baseParams, callback: currentId, keep: true })
		}
		callbackId = undefined
		callback.remove(currentId)
	}

	return {
		add(listener) {
			if (!isFunction(listener) || listeners.has(listener)) return false
			listeners.add(listener)
			return true
		},
		remove(listener) {
			listeners.delete(listener)
		},
		activate() {
			if (callbackId || sealed) return
			// 事件到达时先取监听快照：终态事件当场就把这个事件 seal 掉（清空 listeners），
			// 而派发可能被排到队列里晚一步执行，快照保证事件发生那一刻已经注册的监听
			// 都能收到，之后新注册的则收不到。
			const id = callback.store(value => emit(value, [...listeners]), true)
			callbackId = id
			try {
				invokeAPI(onName, { ...baseParams, callback: id, keep: true })
			}
			catch (error) {
				callbackId = undefined
				callback.remove(id)
				throw error
			}
		},
		rollback() {
			deactivate(true)
		},
		seal() {
			deactivate(false)
			listeners.clear()
			sealed = true
		},
	}
}

const socketTaskInternals = new WeakMap()
const socketTaskConstructorToken = Symbol('SocketTask constructor token')

function taskState(task) {
	const state = socketTaskInternals.get(task)
	if (!state) throw new TypeError('Illegal invocation')
	return state
}

function sealTask(state) {
	startedTasks.delete(state.task)
	if (state.terminal) return
	state.terminal = true
	for (const event of Object.values(state.events)) {
		event.seal()
	}
}

// 连接已经结束这个事实本身：更新私有状态，并记下「终态已由 native 告知」；
// 迟到的 closeSocket fail 不得再把它复活。
function markTerminalState(state) {
	state.connectionState = CLOSED
	state.terminalEvent = true
}

// 终态且不会再有事件到来：连带回收四个 keep callback。
function terminateTask(state) {
	markTerminalState(state)
	sealTask(state)
}

function activateTaskEvents(state) {
	if (state.activated || state.terminal) return
	state.activated = true
	const activated = []
	try {
		for (const event of Object.values(state.events)) {
			if (state.terminal) break
			event.activate()
			activated.push(event)
		}
	}
	catch (error) {
		state.activated = false
		for (const event of activated.reverse()) {
			try {
				event.rollback()
			}
			catch {
				// 保留最初的注册错误；回滚失败不能把真正原因覆盖掉。
			}
		}
		throw error
	}
}

function onTaskEvent(task, name, listener) {
	const state = taskState(task)
	const event = state.events[name]
	if (state.terminal) return
	if (!event.add(listener)) return

	try {
		if (!state.activated) {
			activateTaskEvents(state)
		}
	}
	catch (error) {
		event.remove(listener)
		throw error
	}
}

function deliverTaskEvent(name, listeners, result) {
	invokeSafelyAll(undefined, listeners, [result], `SocketTask.${name}`, false)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/SocketTask.html
 * SocketTask 类，用于管理 WebSocket 连接
 */
class SocketTask {
	constructor(token, socketId) {
		if (token !== socketTaskConstructorToken) {
			throw new TypeError('Illegal constructor')
		}
		const task = this
		const state = {
			task,
			socketId,
			connectionState: CONNECTING,
			// 这条连接有没有真的 open 过：决定 error 之后还等不等成对的 close。
			opened: false,
			// native 是否已经告知终态：决定迟到的 closeSocket fail 能不能回滚乐观置的 CLOSED。
			terminalEvent: false,
			terminal: false,
			activated: false,
			events: {},
		}

		state.events = {
			open: createTaskSocketEvent('onSocketOpen', 'offSocketOpen', { socketId }, (value, listeners) => {
				state.connectionState = OPEN
				state.opened = true
				const isBound = task === boundTask
				deliverInOrder(() => {
					deliverTaskEvent('onOpen', listeners, projectEvent(value, TASK_EVENT_FIELDS.open))
					deliverGlobalEvent(isBound, 'open', value)
				})
			}),
			message: createTaskSocketEvent('onSocketMessage', 'offSocketMessage', { socketId }, (value, listeners) => {
				const isBound = task === boundTask
				const result = decodeIncomingMessage(value)
				deliverInOrder(() => {
					deliverTaskEvent('onMessage', listeners, result)
					deliverGlobalEvent(isBound, 'message', result)
				})
			}),
			error: createTaskSocketEvent('onSocketError', 'offSocketError', { socketId }, (value, listeners) => {
				const isBound = task === boundTask
				// 已 open 过的连接异常失败时 native 是 error → close 双发，这里当场封存会把
				// close 监听一起摘掉，业务永远等不到 onClose。只有从未 open（握手就失败）
				// 才没有成对的 close 会来，那种情况必须当场封存，否则四个 keep 回调永远挂着。
				if (state.opened) {
					markTerminalState(state)
				}
				else {
					terminateTask(state)
				}
				// error 一律推迟到下一个宏任务：connectSocket 要来得及先返回，调用方要来得及
				// 注册 onError。紧随其后的 close 会排在它后面，顺序不会反。
				deliverInOrder(() => {
					deliverTaskEvent('onError', listeners, projectEvent(value, TASK_EVENT_FIELDS.error))
					deliverGlobalEvent(isBound, 'error', value)
				}, { defer: true })
			}),
			close: createTaskSocketEvent('onSocketClose', 'offSocketClose', { socketId }, (value, listeners) => {
				const isBound = task === boundTask
				terminateTask(state)
				deliverInOrder(() => {
					deliverTaskEvent('onClose', listeners, projectEvent(value, TASK_EVENT_FIELDS.close))
					deliverGlobalEvent(isBound, 'close', value)
				})
			}),
		}
		socketTaskInternals.set(this, state)
	}

	/**
	 * 通过 WebSocket 连接发送数据
	 * @param {Object} opts
	 */
	send(opts = {}) {
		const state = taskState(this)
		const options = isSettlerObject(opts) ? opts : {}

		if (state.connectionState !== OPEN) {
			settleFailure(options, { errMsg: 'SocketTask.send:fail WebSocket is not connected' })
			return
		}

		// 只下发微信定义的字段及内部 socketId；调用方伪造的 socketId/isBuffer/keep/evtId
		// 既不能切换连接，也不能篡改桥回调的生命周期。
		const params = applyOutgoingData({ socketId: state.socketId }, options.data)
		attachSettlers(params, options, createSettlerProjection())

		invokeAPIWithoutPromise('sendSocketMessage', params)
	}

	/**
	 * 关闭 WebSocket 连接
	 * @param {Object} opts
	 */
	close(opts = {}) {
		const state = taskState(this)
		const options = isSettlerObject(opts) ? opts : {}

		// code 非 Number 与非有限数一律回落 1000（理由见 normalizeCloseCode），字符串
		// "1000" 也不强转；是有限 Number 就原样下发，脚本层不做 RFC6455 的范围校验。
		// reason 完全不加工，没传就不下发。
		const params = { socketId: state.socketId, code: normalizeCloseCode(options.code) }
		if (options.reason !== undefined) {
			params.reason = options.reason
		}
		attachSettlers(params, options, createSettlerProjection())

		invokeAPIWithoutPromise('closeSocket', params)
	}

	/**
	 * 监听 WebSocket 连接打开事件
	 * @param {Function} callback 回调函数
	 */
	onOpen(callbackFn) {
		onTaskEvent(this, 'open', callbackFn)
	}

	/**
	 * 监听 WebSocket 接受到服务器的消息事件
	 * @param {Function} callback 回调函数
	 */
	onMessage(callbackFn) {
		onTaskEvent(this, 'message', callbackFn)
	}

	/**
	 * 监听 WebSocket 错误事件
	 * @param {Function} callback 回调函数
	 */
	onError(callbackFn) {
		onTaskEvent(this, 'error', callbackFn)
	}

	/**
	 * 监听 WebSocket 连接关闭事件
	 * @param {Function} callback 回调函数
	 */
	onClose(callbackFn) {
		onTaskEvent(this, 'close', callbackFn)
	}
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
 * @returns {SocketTask|undefined} 校验通过时返回 WebSocket 任务对象，参数非法时返回 undefined
 */
export function connectSocket(opts) {
	// 参数不是对象时没有 fail 通道可派：不抛错、不下发 native、返回 undefined。
	if (!isSettlerObject(opts)) {
		return
	}

	const { url } = opts
	if (typeof url !== 'string') {
		settleFailure(opts, {
			errMsg: `connectSocket:fail parameter error: parameter.url should be String instead of ${typeNameOf(url)};`,
		})
		return
	}
	// 空串、ws 和其他协议都走 invalid url，url 原样放进引号里。
	if (!WEBSOCKET_URL.test(url)) {
		settleFailure(opts, { errMsg: `connectSocket:fail invalid url "${url}"` })
		return
	}

	const socketId = `socket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
	const task = new SocketTask(socketTaskConstructorToken, socketId)
	const state = taskState(task)

	const previousBoundTask = boundTask
	if (!boundTask || taskState(boundTask).connectionState === CLOSED) {
		boundTask = task
	}

	// 所有未终态连接共同占用 5 条名额。超限任务不下发 native，并立即封存，避免事后 on*
	// 登记永不回收的 keep 订阅。这一步在读可选参数之前，超限时可选字段 getter 不会执行。
	if (startedTasks.size >= MAX_CONNECT_COUNT) {
		state.connectionState = CLOSED
		sealTask(state)
		settleFailure(opts, { errMsg: `connectSocket:fail fail reach max websocket connect count ${MAX_CONNECT_COUNT}` })
		return task
	}
	// 在读取其余 getter 前先预占名额。getter 可以重入 connectSocket；若等到下发 native 前
	// 才入表，多个嵌套调用会同时绕过 5 条上限。
	startedTasks.add(task)

	const projection = createSettlerProjection()
	// 读 opts 的每个字段都会触发调用方的 getter，getter 可以抛。此时全局绑定已经改到这条
	// 连接上，而它还没发给 native，也就永远不会有终态事件来把它从绑定上摘下来——异常一路
	// 抛出去的话，绑定就永久钉在一条从未发起的连接上，之后所有全局 socket 接口都失效。
	// 所以这段包一层：抛出时先把绑定还给原来那条，再原样重抛，异常本身仍归调用方处理。
	let params
	let callerFail
	try {
		// 只下发微信定义的 connectSocket 字段及内部 socketId，未知扩展字段不穿透到 native。
		// 每个 getter 只读取一次并保存快照；可选参数没传就是没传，脚本层不代填默认值。
		const timeout = opts.timeout
		params = { socketId, url, timeout: normalizeTimeout(timeout) }
		// header 非 object 且非 undefined 时被静默丢弃；null 下发空对象，数组按键名映射。
		const header = opts.header
		if (header !== undefined && typeof header === 'object') {
			params.header = header ? normalizeHeader(header) : {}
		}
		for (const name of ['protocols', 'tcpNoDelay', 'perMessageDeflate', 'forceCellularNetwork']) {
			const value = opts[name]
			if (value !== undefined) {
				params[name] = value
			}
		}
		const success = opts.success
		callerFail = opts.fail
		const complete = opts.complete
		if (isFunction(success)) {
			params.success = projection.wrap('success', success)
		}
		if (isFunction(complete)) {
			params.complete = projection.wrap('complete', complete)
		}
	}
	catch (error) {
		terminateTask(state)
		if (boundTask === task) {
			boundTask = previousBoundTask
		}
		throw error
	}
	// native 侧的前置失败不会产生 error/close 事件，必须从 connect fail 封住任务并回收其
	// bridge keep callbacks。始终提供内部 fail wrapper，也确保 connectSocket 不被 Promise 化。
	params.fail = (error) => {
		terminateTask(state)
		const result = projection.settle(error)
		if (isFunction(callerFail)) callerFail(result)
	}

	// native 受理 connectSocket 之后脚本层才登记四个事件，登记这一步失败时连接已经在路上了。
	let dispatched = false
	try {
		invokeAPI('connectSocket', params)
		dispatched = true
		// 四个桥回调在这里无条件登记：连接内部状态不能取决于调用方是否注册了业务监听。
		// 否则 open 会丢失，send 永远失败，并发名额也无法在终态时正确归还。
		activateTaskEvents(state)
	}
	catch (error) {
		// 同步异常一律不外抛：调用方拿到的是 undefined 加一次 fail 回调。往外抛会让没有
		// try/catch 的调用方直接崩在 connectSocket 上。
		// 这条连接等于从未发起：退出注册表并把绑定还给原来那条，否则它会永久滞留在
		// 注册表里，还可能占住全局绑定让后建的连接永远接管不了。
		// 但脚本层单方面忘掉它不等于它不存在：connectSocket 已经下发时 native 会照常握手，
		// 而四个事件一个都没登记，这条连接谁也收不到、谁也关不掉，还占着 native 的并发名额。
		// 所以补一刀撤销。桥这时多半已经不可用，撤销发不出去也只能算了，但不能因此盖掉
		// 最初那个失败原因。
		if (dispatched) {
			try {
				invokeAPIWithoutPromise('closeSocket', { socketId, code: 1000 })
			}
			catch {
				// 撤销本身失败：原始失败原因优先，这里不改写。
			}
		}
		terminateTask(state)
		if (boundTask === task) {
			boundTask = previousBoundTask
		}
		// 报的是最初那个失败原因：登记中途失败时 activateTaskEvents 会先回滚已登记项，
		// 回滚自身再抛错也只在它内部被吞掉，抛出来的始终是最早那次登记失败。
		settleFailure(opts, { errMsg: `connectSocket:fail ${error?.message ?? error}` })
		return
	}
	return task
}

/**
 * 通过 WebSocket 连接发送数据（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts
 */
export function sendSocketMessage(opts) {
	const options = isSettlerObject(opts) ? opts : {}
	const settled = hasSettlerKey(options)

	// 只作用于当前连接，且要求它 OPEN。
	if (!boundTask || taskState(boundTask).connectionState !== OPEN) {
		return settleGlobalFailure('sendSocketMessage:fail WebSocket is not connected', options, settled)
	}

	const params = applyOutgoingData({ socketId: taskState(boundTask).socketId }, options.data)
	return invokeGlobalSocketAPI('sendSocketMessage', params, options, settled)
}

/**
 * 关闭 WebSocket 连接（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Object} opts
 */
export function closeSocket(opts) {
	const options = isSettlerObject(opts) ? opts : {}
	const settled = hasSettlerKey(options)

	let result
	if (boundTask && taskState(boundTask).connectionState === OPEN) {
		const state = taskState(boundTask)
		const rollback = closeOptimistically(state)
		// 读 code / reason 会触发调用方的 getter，getter 可以抛。此时内部状态已被乐观关闭，
		// 但 native 尚未收到请求，因此异常抛出前必须回滚。
		try {
			const code = normalizeCloseCode(options.code)
			const reason = options.reason
			const params = { socketId: state.socketId, code }
			if (reason !== undefined) {
				params.reason = reason
			}
			// success / fail / complete getter 同样处于回滚边界内：任一 getter 抛出时 native
			// 尚未收到 close，不能让 service 保留错误的关闭状态。
			result = invokeGlobalSocketAPI('closeSocket', params, options, settled, rollback)
		}
		catch (error) {
			rollback()
			throw error
		}
	}
	else {
		// 官方示例明确要求在 wx.onSocketOpen 之后调用；没有已打开的全局目标时直接失败。
		result = settleGlobalFailure('closeSocket:fail WebSocket is not connected', options, settled)
	}

	return result
}

// 全局关闭被 native 拒绝时，恢复调用前的内部状态；已经收到终态事件则不得复活。
function closeOptimistically(state) {
	const previousConnectionState = state.connectionState
	state.connectionState = CLOSED
	return () => {
		if (!state.terminalEvent) {
			state.connectionState = previousConnectionState
		}
	}
}

// 全局 send / close 的返回值只有 void 和 Promise 两种：调用方给了 settler 键就返回 void，
// 一个都没给才返回 Promise，桥的返回值不透传给调用方。
function invokeGlobalSocketAPI(name, params, options, settled, onFail) {
	if (!settled) {
		// Promise 形态同样要过 settler 载荷的字段白名单：invokePromiseAPI 是把 native 的原始载荷
		// 直接 resolve / reject 出去的，不在这里投影，同一个 API 换个调用形态业务拿到的
		// res 形状就不一样了。
		return invokeAPI(name, params).then(
			result => projectSettlerResult(result),
			(error) => {
				onFail?.(error)
				throw projectSettlerResult(error)
			},
		)
	}
	// 回调 id 只能由脚本层生成。invokeAPI 对非函数的 settler 值是**原样下发**当回调 id 的，
	// 调用方于是可以把别的连接已登记的 id 塞进来，native 按 id 回调时打中的是那条连接的
	// 业务监听——跨连接劫持。所以这里只放行函数，非函数值一律换成 undefined：键还在，
	// void / Promise 的分流判据（键是否存在）不受影响，但 id 绝不来自调用方。
	const projection = createSettlerProjection()
	for (const key of ['success', 'complete']) {
		if (Object.prototype.hasOwnProperty.call(options, key)) {
			params[key] = isFunction(options[key]) ? projection.wrap(key, options[key]) : undefined
		}
	}
	const callerFail = isFunction(options.fail) ? options.fail : undefined
	if (onFail || callerFail) {
		params.fail = (error) => {
			onFail?.(error)
			const result = projection.settle(error)
			callerFail?.(result)
		}
	}
	else if (Object.prototype.hasOwnProperty.call(options, 'fail')) {
		params.fail = undefined
	}
	// params.fail 只在 native 回来一个失败结果时才被调用，桥自己同步抛出时它一次都不会跑。
	// wx.closeSocket 的 onFail 是那次乐观置 CLOSED 的回滚，漏掉它，脚本层就认定这条连接
	// 已经关了，而 native 一个字节都没收到、传输层还开着。所以这里补一次回滚再原样重抛。
	try {
		invokeAPI(name, params)
	}
	catch (error) {
		onFail?.(error)
		throw error
	}
}

function settleGlobalFailure(errMsg, options, settled) {
	const result = { errMsg }
	if (!settled) {
		// 一个 settler 键都没给时返回的是 Promise，脚本层的 fail 就落在 reject 上。
		// reject 的是 { errMsg } 这个 fail 结果本身，与 invokePromiseAPI 把原生 fail
		// 结果原样 reject 出去一致；包成 Error 会让调用方读不到 errMsg。
		// eslint-disable-next-line prefer-promise-reject-errors
		return new Promise((resolve, reject) => reject(result))
	}
	settleFailure(options, result)
}

// 全局监听是单槽覆盖：同名事件只保留最后一次注册的回调，非函数参数直接忽略。
function registerGlobalListener(name, listener) {
	if (!isFunction(listener)) {
		return
	}
	globalListeners[name] = listener
}

/**
 * 监听 WebSocket 连接打开事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback
 */
export function onSocketOpen(callbackFn) {
	registerGlobalListener('open', callbackFn)
}

/**
 * 监听 WebSocket 接受到服务器的消息事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback
 */
export function onSocketMessage(callbackFn) {
	registerGlobalListener('message', callbackFn)
}

/**
 * 监听 WebSocket 错误事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback
 */
export function onSocketError(callbackFn) {
	registerGlobalListener('error', callbackFn)
}

/**
 * 监听 WebSocket 连接关闭事件（全局方法，不推荐使用）
 * @deprecated 推荐使用 SocketTask 的方式管理 WebSocket 连接
 * @param {Function} callback
 */
export function onSocketClose(callbackFn) {
	registerGlobalListener('close', callbackFn)
}
