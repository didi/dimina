import { describe, expect, it } from 'vitest'
import { WebSocketValidation } from '../src/core/webSocketValidation.js'

describe('WebSocketValidation', () => {
	it.each([
		'wss://example.com/socket',
		'WSS://example.com/socket',
		'wss://127.0.0.1:8955/path?x=1',
		'wss://[::1]:8955/path',
		'wss://example.com/%23fragment',
	])('接受合法 wss 地址：%s', (url) => {
		expect(WebSocketValidation.validateUrl(url)).toEqual({ ok: true, value: url })
	})

	it.each([
		'ws://example.com/socket',
		'https://example.com/socket',
		'wss:///socket',
		'wss://example.com/#',
		'wss://example.com/path#fragment',
		'wss://example.com/a b',
		'wss://example.com/%',
		'wss://example.com/%2',
		'wss://example.com/%zz',
	])('拒绝非法或非 wss 地址：%s', (url) => {
		expect(WebSocketValidation.validateUrl(url)).toEqual({ ok: false, error: 'invalid url' })
	})

	it('连接超时遵循调用参数、app.json、60000 的优先级和 32 位上限', () => {
		expect(WebSocketValidation.validateTimeout(2500.9, 8000)).toEqual({ ok: true, value: 2500 })
		expect(WebSocketValidation.validateTimeout(0, 8000)).toEqual({ ok: true, value: 8000 })
		expect(WebSocketValidation.validateTimeout(0, 0)).toEqual({ ok: true, value: 60000 })
		expect(WebSocketValidation.validateTimeout(0x80000000, 8000)).toEqual({ ok: false, error: 'invalid timeout' })
	})

	it('子协议只接受非空字符串数组', () => {
		expect(WebSocketValidation.validateProtocols(['chat', 'superchat'])).toEqual({ ok: true, value: ['chat', 'superchat'] })
		expect(WebSocketValidation.validateProtocols('chat')).toEqual({ ok: false, error: 'protocols must be an array' })
		expect(WebSocketValidation.validateProtocols([''])).toEqual({ ok: false, error: 'invalid protocol' })
	})

	it('请求头过滤受限字段，并与原生端使用同一套字符校验', () => {
		expect(WebSocketValidation.validateHeader({ Referer: 'forged', ' X-Test ': 'ok' })).toEqual({
			ok: true,
			value: { 'X-Test': 'ok' },
		})
		expect(WebSocketValidation.validateHeader({ 'Bad:Name': 'value' })).toEqual({ ok: false, error: 'invalid header' })
		expect(WebSocketValidation.validateHeader({ 'X-Test': '中文' })).toEqual({ ok: false, error: 'invalid header' })
	})

	it('关闭码与关闭原因限制和原生端一致', () => {
		expect(WebSocketValidation.validateCloseCode(1000)).toEqual({ ok: true, value: 1000 })
		expect(WebSocketValidation.validateCloseCode(3000)).toEqual({ ok: true, value: 3000 })
		expect(WebSocketValidation.validateCloseCode(1001)).toEqual({ ok: false, error: 'invalid code' })
		expect(WebSocketValidation.validateReason('中'.repeat(41))).toEqual({ ok: true, value: '中'.repeat(41) })
		expect(WebSocketValidation.validateReason('中'.repeat(42))).toEqual({ ok: false, error: 'reason must not exceed 123 UTF-8 bytes' })
	})
})
