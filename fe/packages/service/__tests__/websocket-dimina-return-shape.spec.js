import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

// 判定的是「参数对象上有没有 success/fail/complete 这个键」，Promise 化本身由真实的
// invokeAPI 决定，所以这里的桩必须打在桥上而不是 @/api/common 上。
// send/close 的返回值形态一律在「有一条 OPEN 的当前连接」的前提下判定，否则会跟全局 send
// 的 fail 路径混在一起。

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

describe('sendSocketMessage / closeSocket 按“键是否存在”分流', () => {
	it('一个 settler 键都没有时返回 Promise', () => {
		api.openConnection()

		expect(api.sendSocketMessage({ data: 'hi' })).toBeInstanceOf(Promise)
	})

	it('无参 closeSocket 返回 Promise', () => {
		api.openConnection()

		expect(api.closeSocket()).toBeInstanceOf(Promise)
	})

	it('closeSocket 只传 code 时仍返回 Promise', () => {
		api.openConnection()

		expect(api.closeSocket({ code: 1000 })).toBeInstanceOf(Promise)
	})

	it.each([
		['success'],
		['fail'],
		['complete'],
	])('sendSocketMessage 的 %s 键存在但值是 undefined 时返回 void', (key) => {
		api.openConnection()

		expect(api.sendSocketMessage({ data: 'hi', [key]: undefined })).toBeUndefined()
	})

	it.each([
		['success'],
		['fail'],
		['complete'],
	])('closeSocket 的 %s 键存在但值是 undefined 时返回 void', (key) => {
		api.openConnection()

		expect(api.closeSocket({ [key]: undefined })).toBeUndefined()
	})

	it('传真正的回调函数时返回 void', () => {
		api.openConnection()

		expect(api.sendSocketMessage({ data: 'hi', success: vi.fn() })).toBeUndefined()
		expect(api.closeSocket({ complete: vi.fn() })).toBeUndefined()
	})
})

describe('connectSocket 永不返回 Promise', () => {
	it.each([
		['不带 settler', { url: 'wss://example.com' }],
		['带 success/fail', { url: 'wss://example.com', success: () => {}, fail: () => {} }],
	])('%s 时返回的是 SocketTask 而不是 Promise', (_case, opts) => {
		const task = api.connectSocket(opts)

		expect(task).not.toBeInstanceOf(Promise)
		expect(typeof task.send).toBe('function')
	})

	it('校验失败时返回 undefined，也不是 Promise', () => {
		const task = api.connectSocket({ url: 'http://example.com', fail: () => {} })

		expect(task).toBeUndefined()
	})
})

describe('SocketTask 六个方法与四个全局 on* 一律返回 undefined', () => {
	it('SocketTask 的六个方法都返回 undefined', () => {
		const { task } = api.openConnection()

		expect(task.send({ data: 'hi' })).toBeUndefined()
		expect(task.close()).toBeUndefined()
		expect(task.onOpen(vi.fn())).toBeUndefined()
		expect(task.onMessage(vi.fn())).toBeUndefined()
		expect(task.onError(vi.fn())).toBeUndefined()
		expect(task.onClose(vi.fn())).toBeUndefined()
	})

	it('四个全局 wx.onSocket* 都返回 undefined', () => {
		api.openConnection()

		expect(api.onSocketOpen(vi.fn())).toBeUndefined()
		expect(api.onSocketMessage(vi.fn())).toBeUndefined()
		expect(api.onSocketError(vi.fn())).toBeUndefined()
		expect(api.onSocketClose(vi.fn())).toBeUndefined()
	})
})
