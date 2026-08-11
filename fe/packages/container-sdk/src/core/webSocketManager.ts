import { WebSocketValidation } from './webSocketValidation.js'

const MAX_CONNECTIONS = 5
const BACKGROUND_GRACE_MS = 5000
const TERMINAL_REPLAY_CAPACITY = 32

const CONNECT_FAILED_ERR_MSG = 'connectSocket:fail WebSocket connection failed'
const CONNECT_TIMEOUT_ERR_MSG = 'connectSocket:fail timeout'

type CallbackId = unknown
type SocketEventName = 'open' | 'message' | 'error' | 'close'
type SocketState = 'CREATED' | 'CONNECTING' | 'OPEN' | 'CLOSING'

type ApiParams = Record<string, unknown> & {
	socketId?: unknown
	success?: CallbackId
	fail?: CallbackId
	complete?: CallbackId
	callback?: CallbackId
}

interface TerminalReplay {
	payload: Record<string, unknown>
	deliveredCallbackIds: Set<CallbackId>
}

interface SocketEntry {
	socketId: string
	state: SocketState
	opened: boolean
	closedByGlobalApi: boolean
	errorEmitted: boolean
	transport: WebSocket | null
	connectTimer: ReturnType<typeof setTimeout> | null
	dialTimer: ReturnType<typeof setTimeout> | null
	listeners: Record<SocketEventName, Set<CallbackId>>
	openPayload: Record<string, unknown> | null
	openDeliveredCallbackIds: Set<CallbackId>
	requestedCloseCode: number | null
	requestedCloseReason: string | null
}

export interface WebSocketManagerOptions {
	emitCallback: (callbackId: CallbackId, payload?: unknown) => void
	getAppConnectTimeout?: () => number | undefined
	webSocketFactory?: (url: string, protocols: string[]) => WebSocket
}

function isUsableCallbackId(callbackId: CallbackId): boolean {
	return callbackId !== undefined && callbackId !== null && callbackId !== ''
}

function encodeBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	const chunkSize = 0x8000
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
	}
	return btoa(binary)
}

function decodeBase64(value: unknown): ArrayBuffer | null {
	if (typeof value !== 'string' || value.length % 4 !== 0) {
		return null
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		return null
	}
	try {
		const binary = atob(value)
		const bytes = new Uint8Array(binary.length)
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index)
		}
		return bytes.buffer
	}
	catch {
		return null
	}
}

/** Web 容器的 wx.connectSocket / SocketTask 传输与生命周期管理器。 */
export class WebSocketManager {
	private readonly emitCallback: WebSocketManagerOptions['emitCallback']
	private readonly getAppConnectTimeout: () => number | undefined
	private readonly webSocketFactory: NonNullable<WebSocketManagerOptions['webSocketFactory']>
	private readonly sockets = new Map<string, SocketEntry>()
	private readonly terminalReplay = new Map<string, TerminalReplay>()
	private readonly legacyListeners: Record<SocketEventName, Set<CallbackId>> = {
		open: new Set(),
		message: new Set(),
		error: new Set(),
		close: new Set(),
	}
	private legacyBoundSocketId: string | null = null
	private backgrounded = false
	private backgroundTimer: ReturnType<typeof setTimeout> | null = null
	private destroyed = false

	constructor(options: WebSocketManagerOptions) {
		this.emitCallback = options.emitCallback
		this.getAppConnectTimeout = options.getAppConnectTimeout ?? (() => undefined)
		this.webSocketFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols))
	}

	connectSocket(params: ApiParams = {}): void {
		if (this.destroyed || this.backgrounded) {
			this.fail('connectSocket', params, 'interrupted')
			return
		}

		const socketId = typeof params.socketId === 'string' ? params.socketId : ''
		if (!socketId || this.sockets.has(socketId)) {
			this.fail('connectSocket', params, 'invalid socketId')
			return
		}
		if (this.sockets.size >= MAX_CONNECTIONS) {
			this.fail('connectSocket', params, `fail reach max websocket connect count ${MAX_CONNECTIONS}`)
			return
		}

		const urlResult = WebSocketValidation.validateUrl(params.url)
		if (!urlResult.ok) {
			this.fail('connectSocket', params, urlResult.error)
			return
		}
		const timeoutResult = WebSocketValidation.validateTimeout(params.timeout, this.getAppConnectTimeout())
		if (!timeoutResult.ok) {
			this.fail('connectSocket', params, timeoutResult.error)
			return
		}
		const protocolsResult = WebSocketValidation.validateProtocols(params.protocols)
		if (!protocolsResult.ok) {
			this.fail('connectSocket', params, protocolsResult.error)
			return
		}
		const headerResult = WebSocketValidation.validateHeader(params.header)
		if (!headerResult.ok) {
			this.fail('connectSocket', params, headerResult.error)
			return
		}

		this.clearTerminalReplay(socketId)
		const entry: SocketEntry = {
			socketId,
			state: 'CREATED',
			opened: false,
			closedByGlobalApi: false,
			errorEmitted: false,
			transport: null,
			connectTimer: null,
			dialTimer: null,
			listeners: { open: new Set(), message: new Set(), error: new Set(), close: new Set() },
			openPayload: null,
			openDeliveredCallbackIds: new Set(),
			requestedCloseCode: null,
			requestedCloseReason: null,
		}
		this.sockets.set(socketId, entry)

		const boundEntry = this.legacyBoundSocketId ? this.sockets.get(this.legacyBoundSocketId) : undefined
		if (!boundEntry || boundEntry.closedByGlobalApi) {
			this.legacyBoundSocketId = socketId
		}

		this.succeed('connectSocket', params)
		// 宿主回调实现可能同步重入 close/destroy；已终止的条目不能在回调返回后重新挂上定时器。
		if (!this.isCurrent(entry)) return
		entry.connectTimer = setTimeout(() => this.handleConnectTimeout(entry), timeoutResult.value)
		entry.dialTimer = setTimeout(() => this.startDialing(entry, urlResult.value, protocolsResult.value), 0)
	}

	sendSocketMessage(params: ApiParams = {}): void {
		if (this.destroyed || this.backgrounded) {
			this.fail('sendSocketMessage', params, 'interrupted')
			return
		}
		const entry = this.resolveEntry(params)
		if (!entry || entry.state !== 'OPEN' || !entry.transport) {
			this.fail('sendSocketMessage', params, 'WebSocket is not connected')
			return
		}

		let data: string | ArrayBuffer
		if (params.isBuffer === true) {
			const decoded = decodeBase64(params.data)
			if (!decoded) {
				this.fail('sendSocketMessage', params, 'data must be string or ArrayBuffer')
				return
			}
			data = decoded
		}
		else if (typeof params.data === 'string') {
			data = params.data
		}
		else {
			this.fail('sendSocketMessage', params, 'data must be string or ArrayBuffer')
			return
		}

		try {
			entry.transport.send(data)
		}
		catch {
			this.fail('sendSocketMessage', params, 'WebSocket is not connected')
			return
		}
		this.succeed('sendSocketMessage', params)
	}

	closeSocket(params: ApiParams = {}): void {
		if (this.destroyed || this.backgrounded) {
			this.fail('closeSocket', params, 'interrupted')
			return
		}
		const taskMode = typeof params.socketId === 'string' && params.socketId.length > 0
		const entry = this.resolveEntry(params)
		if (!entry || entry.state === 'CLOSING' || (!taskMode && entry.state !== 'OPEN')) {
			this.fail('closeSocket', params, 'WebSocket is not connected')
			return
		}

		const codeResult = WebSocketValidation.validateCloseCode(params.code)
		if (!codeResult.ok) {
			this.fail('closeSocket', params, codeResult.error)
			return
		}
		const reasonResult = WebSocketValidation.validateReason(params.reason)
		if (!reasonResult.ok) {
			this.fail('closeSocket', params, reasonResult.error)
			return
		}
		if (!taskMode) {
			entry.closedByGlobalApi = true
		}

		const code = codeResult.value
		const reason = reasonResult.value
		if (entry.state === 'CREATED' || entry.state === 'CONNECTING') {
			this.detachEntry(entry)
			this.closeTransport(entry.transport, code, reason)
			this.dispatchEvent(entry, 'close', { code, reason })
			this.succeed('closeSocket', params)
			return
		}

		entry.state = 'CLOSING'
		entry.requestedCloseCode = code
		entry.requestedCloseReason = reason
		try {
			entry.transport?.close(code, reason)
		}
		catch {
			entry.state = 'OPEN'
			entry.requestedCloseCode = null
			entry.requestedCloseReason = null
			this.fail('closeSocket', params, 'WebSocket is not connected')
			return
		}
		this.succeed('closeSocket', params)
	}

	onSocketEvent(event: SocketEventName, params: ApiParams = {}): void {
		const callbackId = params.callback
		if (isUsableCallbackId(callbackId)) {
			const socketId = typeof params.socketId === 'string' ? params.socketId : ''
			if (socketId) {
				this.sockets.get(socketId)?.listeners[event].add(callbackId)
				this.replayMissedEvent(socketId, event, callbackId)
			}
			else {
				this.legacyListeners[event].add(callbackId)
				if (this.legacyBoundSocketId) {
					this.replayMissedEvent(this.legacyBoundSocketId, event, callbackId)
				}
			}
		}
	}

	offSocketEvent(event: SocketEventName, params: ApiParams = {}): void {
		const callbackId = params.callback
		const socketId = typeof params.socketId === 'string' ? params.socketId : ''
		const listeners = socketId ? this.sockets.get(socketId)?.listeners[event] : this.legacyListeners[event]
		if (listeners) {
			if (isUsableCallbackId(callbackId)) listeners.delete(callbackId)
			else listeners.clear()
		}
		if (socketId) {
			this.forgetDeliveredCallback(socketId, event, callbackId)
		}
		else if (this.legacyBoundSocketId) {
			this.forgetDeliveredCallback(this.legacyBoundSocketId, event, callbackId)
		}
	}

	onAppHide(): void {
		if (this.destroyed || this.backgrounded) return
		this.backgrounded = true
		this.backgroundTimer = setTimeout(() => {
			this.backgroundTimer = null
			if (!this.backgrounded || this.destroyed) return
			for (const entry of [...this.sockets.values()]) {
				if (entry.opened) {
					this.terminateOpenedEntry(entry, 1006, 'interrupted')
				}
				else {
					this.terminateHandshakeWithError(entry, 'connectSocket:fail interrupted')
				}
			}
		}, BACKGROUND_GRACE_MS)
	}

	onAppShow(): void {
		if (this.destroyed) return
		this.backgrounded = false
		if (this.backgroundTimer !== null) {
			clearTimeout(this.backgroundTimer)
			this.backgroundTimer = null
		}
	}

	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer)
		this.backgroundTimer = null
		for (const entry of [...this.sockets.values()]) {
			this.detachEntry(entry)
			this.closeTransport(entry.transport, 1000, '')
		}
		this.sockets.clear()
		this.terminalReplay.clear()
		for (const listeners of Object.values(this.legacyListeners)) listeners.clear()
		this.legacyBoundSocketId = null
	}

	private startDialing(entry: SocketEntry, url: string, protocols: string[]): void {
		entry.dialTimer = null
		if (!this.isCurrent(entry) || entry.state !== 'CREATED') return
		entry.state = 'CONNECTING'
		let transport: WebSocket
		try {
			transport = this.webSocketFactory(url, protocols)
			entry.transport = transport
			transport.binaryType = 'arraybuffer'
			transport.onopen = () => this.handleOpen(entry)
			transport.onmessage = event => this.handleMessage(entry, event.data)
			transport.onerror = () => this.handleError(entry)
			transport.onclose = event => this.handleClose(entry, event.code, event.reason)
		}
		catch {
			this.terminateHandshakeWithError(entry, CONNECT_FAILED_ERR_MSG)
		}
	}

	private handleOpen(entry: SocketEntry): void {
		if (!this.isCurrent(entry) || entry.state !== 'CONNECTING') return
		entry.state = 'OPEN'
		entry.opened = true
		this.clearConnectTimer(entry)
		// 浏览器 WebSocket 不暴露握手响应头；保留官方 header 字段，但只能返回空对象。
		entry.openPayload = { header: {} }
		this.dispatchEvent(entry, 'open', entry.openPayload)
	}

	private handleMessage(entry: SocketEntry, data: unknown): void {
		if (!this.isCurrent(entry) || entry.state !== 'OPEN') return
		if (typeof data === 'string') {
			this.dispatchEvent(entry, 'message', { data })
			return
		}
		if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
			this.dispatchEvent(entry, 'message', { data: encodeBase64(data as ArrayBuffer), isBuffer: true })
		}
	}

	private handleError(entry: SocketEntry): void {
		if (!this.isCurrent(entry)) return
		if (!entry.opened) {
			this.terminateHandshakeWithError(entry, CONNECT_FAILED_ERR_MSG)
			return
		}
		if (entry.requestedCloseCode !== null || entry.errorEmitted) return
		entry.errorEmitted = true
		this.dispatchEvent(entry, 'error', { errMsg: CONNECT_FAILED_ERR_MSG })
	}

	private handleClose(entry: SocketEntry, transportCode: number, transportReason: string): void {
		if (!this.isCurrent(entry)) return
		if (!entry.opened) {
			this.terminateHandshakeWithError(entry, CONNECT_FAILED_ERR_MSG)
			return
		}
		const code = entry.requestedCloseCode ?? transportCode
		const reason = entry.requestedCloseReason ?? transportReason
		this.detachEntry(entry)
		this.dispatchEvent(entry, 'close', { code, reason })
	}

	private handleConnectTimeout(entry: SocketEntry): void {
		if (!this.isCurrent(entry) || entry.state === 'OPEN') return
		this.terminateHandshakeWithError(entry, CONNECT_TIMEOUT_ERR_MSG)
	}

	private terminateHandshakeWithError(entry: SocketEntry, errMsg: string): void {
		if (!this.isCurrent(entry)) return
		this.detachEntry(entry)
		this.closeTransport(entry.transport)
		if (!entry.errorEmitted) {
			entry.errorEmitted = true
			this.dispatchEvent(entry, 'error', { errMsg })
		}
	}

	private terminateOpenedEntry(entry: SocketEntry, code: number, reason: string): void {
		if (!this.isCurrent(entry)) return
		this.detachEntry(entry)
		// 1006 是只能用于上报的保留码，不能传给浏览器 WebSocket.close()。
		this.closeTransport(entry.transport)
		this.dispatchEvent(entry, 'close', { code, reason })
	}

	private resolveEntry(params: ApiParams): SocketEntry | undefined {
		if (typeof params.socketId === 'string' && params.socketId.length > 0) {
			return this.sockets.get(params.socketId)
		}
		return this.legacyBoundSocketId ? this.sockets.get(this.legacyBoundSocketId) : undefined
	}

	private dispatchEvent(entry: SocketEntry, event: SocketEventName, payload: Record<string, unknown>): void {
		let deliveredCallbackIds: Set<CallbackId> | undefined
		if (event === 'open') {
			deliveredCallbackIds = entry.openDeliveredCallbackIds
		}
		else if (event === 'error' || event === 'close') {
			deliveredCallbackIds = this.recordTerminalEvent(entry.socketId, event, payload).deliveredCallbackIds
		}
		for (const callbackId of entry.listeners[event]) {
			this.emitEventOnce(callbackId, payload, deliveredCallbackIds)
		}
		if (entry.socketId === this.legacyBoundSocketId) {
			for (const callbackId of this.legacyListeners[event]) {
				this.emitEventOnce(callbackId, payload, deliveredCallbackIds)
			}
		}
	}

	private replayMissedEvent(socketId: string, event: SocketEventName, callbackId: CallbackId): void {
		if (event === 'open') {
			const entry = this.sockets.get(socketId)
			if (entry?.state === 'OPEN' && entry.openPayload) {
				this.emitEventOnce(callbackId, entry.openPayload, entry.openDeliveredCallbackIds)
			}
			return
		}
		if (event === 'error' || event === 'close') {
			const replay = this.terminalReplay.get(this.replayKey(socketId, event))
			if (replay) this.emitEventOnce(callbackId, replay.payload, replay.deliveredCallbackIds)
		}
	}

	private emitEventOnce(callbackId: CallbackId, payload: Record<string, unknown>, delivered?: Set<CallbackId>): void {
		if (delivered && delivered.has(callbackId)) return
		delivered?.add(callbackId)
		this.emit(callbackId, payload)
	}

	private recordTerminalEvent(socketId: string, event: 'error' | 'close', payload: Record<string, unknown>): TerminalReplay {
		const key = this.replayKey(socketId, event)
		const replay = { payload, deliveredCallbackIds: new Set<CallbackId>() }
		this.terminalReplay.delete(key)
		this.terminalReplay.set(key, replay)
		while (this.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
			const oldestKey = this.terminalReplay.keys().next().value
			if (oldestKey === undefined) break
			this.terminalReplay.delete(oldestKey)
		}
		return replay
	}

	private forgetDeliveredCallback(socketId: string, event: SocketEventName, callbackId: CallbackId): void {
		const delivered = event === 'open'
			? this.sockets.get(socketId)?.openDeliveredCallbackIds
			: event === 'error' || event === 'close'
				? this.terminalReplay.get(this.replayKey(socketId, event))?.deliveredCallbackIds
				: undefined
		if (!delivered) return
		if (isUsableCallbackId(callbackId)) delivered.delete(callbackId)
		else delivered.clear()
	}

	private clearTerminalReplay(socketId: string): void {
		this.terminalReplay.delete(this.replayKey(socketId, 'error'))
		this.terminalReplay.delete(this.replayKey(socketId, 'close'))
	}

	private replayKey(socketId: string, event: 'error' | 'close'): string {
		return `${socketId}|${event}`
	}

	private isCurrent(entry: SocketEntry): boolean {
		return this.sockets.get(entry.socketId) === entry
	}

	private detachEntry(entry: SocketEntry): void {
		this.clearConnectTimer(entry)
		if (entry.dialTimer !== null) clearTimeout(entry.dialTimer)
		entry.dialTimer = null
		if (this.isCurrent(entry)) this.sockets.delete(entry.socketId)
		if (entry.transport) {
			entry.transport.onopen = null
			entry.transport.onmessage = null
			entry.transport.onerror = null
			entry.transport.onclose = null
		}
	}

	private clearConnectTimer(entry: SocketEntry): void {
		if (entry.connectTimer !== null) clearTimeout(entry.connectTimer)
		entry.connectTimer = null
	}

	private closeTransport(transport: WebSocket | null, code?: number, reason?: string): void {
		if (!transport) return
		try {
			if (code === undefined) transport.close()
			else transport.close(code, reason)
		}
		catch {
			// 浏览器没有独立 cancel；连接终态已经由管理器确定，迟到的传输事件会被身份检查丢弃。
		}
	}

	private succeed(apiName: string, params: ApiParams): void {
		const result = { errMsg: `${apiName}:ok` }
		this.emit(params.success, result)
		this.emit(params.complete, result)
	}

	private fail(apiName: string, params: ApiParams, error: string): void {
		const result = { errMsg: `${apiName}:fail ${error}` }
		this.emit(params.fail, result)
		this.emit(params.complete, result)
	}

	private emit(callbackId: CallbackId, payload: unknown): void {
		if (isUsableCallbackId(callbackId)) this.emitCallback(callbackId, payload)
	}
}

export type { ApiParams, SocketEventName }
