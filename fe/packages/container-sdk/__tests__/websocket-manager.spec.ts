import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketManager } from '../src/core/webSocketManager.js'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

class FakeWebSocket {
	static instances: FakeWebSocket[] = []

	readonly url: string
	readonly protocols: string[]
	binaryType: BinaryType = 'blob'
	readyState = 0
	onopen: ((event: Event) => void) | null = null
	onmessage: ((event: MessageEvent) => void) | null = null
	onerror: ((event: Event) => void) | null = null
	onclose: ((event: CloseEvent) => void) | null = null
	sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = []
	closeCalls: Array<{ code?: number, reason?: string }> = []

	constructor(url: string, protocols: string[]) {
		this.url = url
		this.protocols = protocols
		FakeWebSocket.instances.push(this)
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error('not open')
		this.sent.push(data)
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason })
		this.readyState = 2
	}

	open(): void {
		this.readyState = 1
		this.onopen?.(new Event('open'))
	}

	message(data: string | ArrayBuffer): void {
		this.onmessage?.({ data } as MessageEvent)
	}

	error(): void {
		this.onerror?.(new Event('error'))
	}

	closed(code = 1000, reason = ''): void {
		this.readyState = 3
		this.onclose?.({ code, reason } as CloseEvent)
	}
}

interface Emission {
	callbackId: unknown
	payload: unknown
}

function createHarness(appTimeout?: number) {
	const emissions: Emission[] = []
	const manager = new WebSocketManager({
		emitCallback: (callbackId, payload) => emissions.push({ callbackId, payload }),
		getAppConnectTimeout: () => appTimeout,
		webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
	})
	return { manager, emissions }
}

function payloads(emissions: Emission[], callbackId: unknown): unknown[] {
	return emissions.filter(item => item.callbackId === callbackId).map(item => item.payload)
}

function connect(manager: WebSocketManager, socketId: string, extra: Record<string, unknown> = {}): void {
	manager.connectSocket({
		socketId,
		url: 'wss://example.com/socket',
		timeout: 1000,
		...extra,
	})
}

describe('WebSocketManager', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		FakeWebSocket.instances = []
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('MiniApp 桥入口沿用四端一致的 WebSocket API 名称', () => {
		for (const name of [
			'connectSocket', 'sendSocketMessage', 'closeSocket',
			'onSocketOpen', 'onSocketMessage', 'onSocketError', 'onSocketClose',
			'offSocketOpen', 'offSocketMessage', 'offSocketError', 'offSocketClose',
		]) {
			expect(typeof MiniApp.prototype[name as keyof MiniApp]).toBe('function')
		}
	})

	it('连接、文本/二进制收发、关闭使用与原生桥一致的字段和回调名称', () => {
		const { manager, emissions } = createHarness()
		manager.connectSocket({
			socketId: 's1',
			url: 'wss://example.com/socket',
			timeout: 1000,
			protocols: ['chat'],
			header: { 'X-Test': 'value' },
			success: 'connect-success',
			complete: 'connect-complete',
		})
		manager.onSocketEvent('open', { socketId: 's1', callback: 'open' })
		manager.onSocketEvent('message', { socketId: 's1', callback: 'message' })
		manager.onSocketEvent('close', { socketId: 's1', callback: 'close' })

		expect(payloads(emissions, 'connect-success')).toEqual([{ errMsg: 'connectSocket:ok' }])
		expect(payloads(emissions, 'connect-complete')).toEqual([{ errMsg: 'connectSocket:ok' }])
		vi.advanceTimersByTime(0)

		const socket = FakeWebSocket.instances[0]
		expect(socket.url).toBe('wss://example.com/socket')
		expect(socket.protocols).toEqual(['chat'])
		expect(socket.binaryType).toBe('arraybuffer')
		socket.open()
		expect(payloads(emissions, 'open')).toEqual([{ header: {} }])

		manager.sendSocketMessage({ socketId: 's1', data: 'hello', success: 'send-text' })
		manager.sendSocketMessage({ socketId: 's1', data: 'AQID', isBuffer: true, success: 'send-buffer' })
		expect(socket.sent[0]).toBe('hello')
		expect([...new Uint8Array(socket.sent[1] as ArrayBuffer)]).toEqual([1, 2, 3])
		expect(payloads(emissions, 'send-text')).toEqual([{ errMsg: 'sendSocketMessage:ok' }])
		expect(payloads(emissions, 'send-buffer')).toEqual([{ errMsg: 'sendSocketMessage:ok' }])

		socket.message('world')
		socket.message(new Uint8Array([1, 2, 3]).buffer)
		expect(payloads(emissions, 'message')).toEqual([
			{ data: 'world' },
			{ data: 'AQID', isBuffer: true },
		])

		manager.closeSocket({ socketId: 's1', code: 3001, reason: 'done', success: 'close-success' })
		expect(socket.closeCalls).toEqual([{ code: 3001, reason: 'done' }])
		expect(payloads(emissions, 'close-success')).toEqual([{ errMsg: 'closeSocket:ok' }])
		socket.closed(1000, 'transport value')
		expect(payloads(emissions, 'close')).toEqual([{ code: 3001, reason: 'done' }])
	})

	it('connect success 回调同步重入关闭时不会在终态后重新启动拨号', () => {
		const emissions: Emission[] = []
		let manager!: WebSocketManager
		manager = new WebSocketManager({
			emitCallback: (callbackId, payload) => {
				emissions.push({ callbackId, payload })
				if (callbackId === 'connect-success') {
					manager.closeSocket({ socketId: 's1', success: 'close-success' })
				}
			},
			webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
		})
		manager.connectSocket({ socketId: 's1', url: 'wss://example.com', success: 'connect-success' })
		vi.advanceTimersByTime(0)
		expect(FakeWebSocket.instances).toHaveLength(0)
		expect(payloads(emissions, 'close-success')).toEqual([{ errMsg: 'closeSocket:ok' }])
	})

	it('所有未终态连接共同受 5 条上限约束', () => {
		const { manager, emissions } = createHarness()
		for (let index = 1; index <= 5; index++) connect(manager, `s${index}`)
		manager.connectSocket({
			socketId: 's6',
			url: 'wss://example.com/socket',
			timeout: 1000,
			fail: 'sixth-fail',
		})
		expect(payloads(emissions, 'sixth-fail')).toEqual([
			{ errMsg: 'connectSocket:fail fail reach max websocket connect count 5' },
		])
		vi.advanceTimersByTime(0)
		expect(FakeWebSocket.instances).toHaveLength(5)
	})

	it('已经发起关闭但尚未收到 close 的连接仍占用名额', () => {
		const { manager, emissions } = createHarness()
		connect(manager, 'closing')
		vi.advanceTimersByTime(0)
		FakeWebSocket.instances[0].open()
		manager.closeSocket({ socketId: 'closing' })
		for (let index = 1; index <= 4; index++) connect(manager, `connecting-${index}`)
		manager.connectSocket({
			socketId: 'sixth',
			url: 'wss://example.com/socket',
			timeout: 1000,
			fail: 'sixth-fail',
		})
		expect(payloads(emissions, 'sixth-fail')).toEqual([
			{ errMsg: 'connectSocket:fail fail reach max websocket connect count 5' },
		])
	})

	it('只接受 wss，并且不把浏览器无法设置的 header 传给 WebSocket 构造器', () => {
		const { manager, emissions } = createHarness()
		manager.connectSocket({ socketId: 'bad', url: 'ws://example.com', fail: 'bad-fail' })
		expect(payloads(emissions, 'bad-fail')).toEqual([{ errMsg: 'connectSocket:fail invalid url' }])
		expect(FakeWebSocket.instances).toHaveLength(0)

		connect(manager, 'good', { header: { 'X-Test': 'value' } })
		vi.advanceTimersByTime(0)
		expect(FakeWebSocket.instances).toHaveLength(1)
	})

	it('任务 close 可以终止握手中连接并立即释放名额，全局 close 则只接受 OPEN 目标', () => {
		const { manager, emissions } = createHarness()
		connect(manager, 's1')
		manager.onSocketEvent('close', { socketId: 's1', callback: 'task-close' })
		vi.advanceTimersByTime(0)
		manager.closeSocket({ socketId: 's1', code: 1000, reason: 'cancel', success: 'task-close-success' })
		expect(payloads(emissions, 'task-close')).toEqual([{ code: 1000, reason: 'cancel' }])
		expect(payloads(emissions, 'task-close-success')).toEqual([{ errMsg: 'closeSocket:ok' }])

		connect(manager, 's2')
		manager.closeSocket({ fail: 'global-close-fail' })
		expect(payloads(emissions, 'global-close-fail')).toEqual([{ errMsg: 'closeSocket:fail WebSocket is not connected' }])
	})

	it('open/error/close 早于桥监听注册时只补发一次，message 不补发', () => {
		const { manager, emissions } = createHarness()
		connect(manager, 's1')
		vi.advanceTimersByTime(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()

		manager.onSocketEvent('open', { socketId: 's1', callback: 'late-open' })
		manager.onSocketEvent('open', { socketId: 's1', callback: 'late-open' })
		expect(payloads(emissions, 'late-open')).toEqual([{ header: {} }])

		socket.closed(1000, 'done')
		manager.onSocketEvent('close', { socketId: 's1', callback: 'late-close' })
		manager.onSocketEvent('close', { socketId: 's1', callback: 'late-close' })
		expect(payloads(emissions, 'late-close')).toEqual([{ code: 1000, reason: 'done' }])
	})

	it('连接超时使用 app.json.networkTimeout.connectSocket 并报告固定错误', () => {
		const { manager, emissions } = createHarness(25)
		manager.connectSocket({
			socketId: 's1',
			url: 'wss://example.com/socket',
			timeout: 0,
		})
		vi.advanceTimersByTime(0)
		vi.advanceTimersByTime(25)
		manager.onSocketEvent('error', { socketId: 's1', callback: 'timeout-error' })
		expect(payloads(emissions, 'timeout-error')).toEqual([{ errMsg: 'connectSocket:fail timeout' }])
	})

	it('后台宽限期内恢复不清连接，超时后按连接阶段派发 interrupted', () => {
		const first = createHarness()
		connect(first.manager, 'open')
		first.manager.onSocketEvent('close', { socketId: 'open', callback: 'close' })
		vi.advanceTimersByTime(0)
		FakeWebSocket.instances[0].open()
		first.manager.onAppHide()
		vi.advanceTimersByTime(4999)
		first.manager.onAppShow()
		vi.advanceTimersByTime(1)
		expect(payloads(first.emissions, 'close')).toEqual([])

		first.manager.onAppHide()
		vi.advanceTimersByTime(5000)
		expect(payloads(first.emissions, 'close')).toEqual([{ code: 1006, reason: 'interrupted' }])

		const second = createHarness()
		connect(second.manager, 'connecting', { timeout: 10000 })
		second.manager.onSocketEvent('error', { socketId: 'connecting', callback: 'error' })
		vi.advanceTimersByTime(0)
		second.manager.onAppHide()
		vi.advanceTimersByTime(5000)
		expect(payloads(second.emissions, 'error')).toEqual([{ errMsg: 'connectSocket:fail interrupted' }])
	})

	it('destroy 静默关闭并清理连接，不派发业务终态事件', () => {
		const { manager, emissions } = createHarness()
		connect(manager, 's1')
		manager.onSocketEvent('close', { socketId: 's1', callback: 'close' })
		vi.advanceTimersByTime(0)
		FakeWebSocket.instances[0].open()
		manager.destroy()
		expect(FakeWebSocket.instances[0].closeCalls).toEqual([{ code: 1000, reason: '' }])
		expect(payloads(emissions, 'close')).toEqual([])
	})
})
