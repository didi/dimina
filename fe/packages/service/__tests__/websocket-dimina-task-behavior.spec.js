import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failResult, flushMacrotask, loadSocketApi } from './websocket-dimina-harness.js'

// 本文件覆盖官方公开的 SocketTask 形状，以及未公开但需保持确定性的 Dimina 参数行为。

const OFFICIAL_METHODS = ['close', 'onClose', 'onError', 'onMessage', 'onOpen', 'send']

let api

beforeEach(async () => {
	api = await loadSocketApi()
})

describe('SocketTask 成员全集', () => {
	it('原型上恰好是官方六个方法，实例自己不持有它们', () => {
		const { task } = api.connect({ url: 'wss://example.com' })
		const proto = Object.getPrototypeOf(task)

		expect(Object.getOwnPropertyNames(proto).sort()).toEqual(['constructor', ...OFFICIAL_METHODS].sort())
		for (const name of OFFICIAL_METHODS) {
			expect(typeof task[name]).toBe('function')
			expect(Object.prototype.hasOwnProperty.call(task, name)).toBe(false)
		}
	})

	it('实例没有自有公开属性', () => {
		const { task } = api.connect({ url: 'wss://example.com' })

		expect(Object.keys(task)).toEqual([])
		expect(Object.getOwnPropertyNames(task)).toEqual([])
	})

	it.each([
		'readyState',
		'CONNECTING',
		'OPEN',
		'CLOSING',
		'CLOSED',
		'offOpen',
		'offMessage',
		'offError',
		'offClose',
		'socketId',
		'_events',
	])('%s 既不在实例上也不在原型上', (name) => {
		const { task } = api.connect({ url: 'wss://example.com' })

		expect(name in task).toBe(false)
		expect(task[name]).toBeUndefined()
	})
})

describe('connectSocket 返回值与校验方式', () => {
	it('校验通过时返回 SocketTask，且永远不是 Promise', () => {
		const { task } = api.connect({ url: 'wss://example.com' })

		expect(task).not.toBeInstanceOf(Promise)
		expect(typeof task.send).toBe('function')
	})

	it.each([
		['缺 url', {}],
		['url 是数字', { url: 123 }],
		['url 为空串', { url: '' }],
		['协议不是 wss', { url: 'http://example.com' }],
		['使用 ws', { url: 'ws://example.com' }],
	])('%s 时返回 undefined，且不下发 native 连接', (_case, opts) => {
		const before = api.paramsOf('connectSocket').length

		const task = api.connectSocket({ ...opts, fail: vi.fn() })

		expect(task).toBeUndefined()
		expect(api.paramsOf('connectSocket')).toHaveLength(before)
	})

	it.each([
		['不传参数', undefined],
		['传数字', 123],
		['传 null', null],
	])('%s 时不同步抛错，返回 undefined，也不下发 native 连接', (_case, opts) => {
		let task

		expect(() => {
			task = api.connectSocket(opts)
		}).not.toThrow()
		expect(task).toBeUndefined()
		expect(api.paramsOf('connectSocket')).toHaveLength(0)
	})

	it('非法参数走 fail 回调而不是同步抛错', () => {
		const fail = vi.fn()

		expect(() => api.connectSocket({ fail })).not.toThrow()

		expect(fail).toHaveBeenCalledTimes(1)
	})
})

describe('connectSocket 的 errMsg 逐字文案', () => {
	it('缺 url 时结果只包含官方声明的 errMsg', () => {
		const fail = vi.fn()

		api.connectSocket({ fail })

		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail parameter error: parameter.url should be String instead of Undefined;',
		})
	})

	it('url 传数字时结果同样不增加 errno', () => {
		const fail = vi.fn()

		api.connectSocket({ url: 123, fail })

		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail parameter error: parameter.url should be String instead of Number;',
		})
	})

	it('url 为空串走 invalid url 而不是 parameter error', () => {
		const fail = vi.fn()

		api.connectSocket({ url: '', fail })

		const result = failResult(fail)
		expect(result.errMsg).toBe('connectSocket:fail invalid url ""')
		expect(result).not.toHaveProperty('errno')
	})

	it('协议不是 wss 时把原样 url 放进引号里', () => {
		const fail = vi.fn()

		api.connectSocket({ url: 'http://example.com/a?b=1', fail })

		const result = failResult(fail)
		expect(result.errMsg).toBe('connectSocket:fail invalid url "http://example.com/a?b=1"')
		expect(result).not.toHaveProperty('errno')
	})

	it('没有协议头的 url 同样按 invalid url 拒绝', () => {
		const fail = vi.fn()

		api.connectSocket({ url: 'example.com', fail })

		expect(failResult(fail).errMsg).toBe('connectSocket:fail invalid url "example.com"')
	})

	it('超并发的 errMsg 逐字带两个 fail，不得被“修正”成一个', () => {
		for (let index = 0; index < 5; index++) {
			api.openConnection(`wss://example.com/${index}`)
		}
		const fail = vi.fn()

		api.connectSocket({ url: 'wss://example.com/overflow', fail })

		expect(failResult(fail).errMsg).toBe('connectSocket:fail fail reach max websocket connect count 5')
	})
})

describe('url 协议：只接受 wss://', () => {
	it.each([
		['wss://example.com'],
		['WSS://example.com'],
		// fragment 与空 host 的细化校验属传输层，service 只负责协议门槛。
		['wss://example.com/#frag'],
		['wss://'],
	])('%s 通过 service 协议校验并下发 native', (url) => {
		const fail = vi.fn()

		const task = api.connectSocket({ url, fail })

		expect(task).toBeDefined()
		expect(fail).not.toHaveBeenCalled()
		expect(api.lastParamsOf('connectSocket').url).toBe(url)
	})

	it.each(['ws://example.com', 'WS://EXAMPLE.COM'])('%s 被 service 拒绝', (url) => {
		const fail = vi.fn()

		const task = api.connectSocket({ url, fail })

		expect(task).toBeUndefined()
		expect(failResult(fail).errMsg).toBe(`connectSocket:fail invalid url "${url}"`)
		expect(api.paramsOf('connectSocket')).toHaveLength(0)
	})
})

describe('所有未终态连接共同受 5 条上限约束', () => {
	it('已有 5 条 OPEN 时第 6 条被拒，且不下发 native 连接', () => {
		for (let index = 0; index < 5; index++) {
			api.openConnection(`wss://example.com/${index}`)
		}
		const fail = vi.fn()

		api.connectSocket({ url: 'wss://example.com/overflow', fail })

		expect(fail).toHaveBeenCalledTimes(1)
		expect(api.paramsOf('connectSocket')).toHaveLength(5)
	})

	it('超并发时仍返回已封存的 SocketTask，后续 send 直接失败', () => {
		for (let index = 0; index < 5; index++) {
			api.openConnection(`wss://example.com/${index}`)
		}
		const sendFail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com/overflow', fail: vi.fn() })
		task.send({ data: 'blocked', fail: sendFail })

		expect(task).toBeDefined()
		expect(failResult(sendFail).errMsg).toBe('SocketTask.send:fail WebSocket is not connected')
	})

	it('已有 5 条 connecting 时第 6 条同样被拒绝', () => {
		for (let index = 0; index < 5; index++) {
			api.connect({ url: `wss://example.com/${index}` })
		}
		const fail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com/sixth', fail })

		expect(task).toBeDefined()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(api.paramsOf('connectSocket')).toHaveLength(5)
	})

	it('close 事件让计数回落，腾出的名额可以再建连接', async () => {
		const handles = []
		for (let index = 0; index < 5; index++) {
			handles.push(api.openConnection(`wss://example.com/${index}`))
		}
		api.fire(handles[0], 'close', { code: 1000, reason: '' })
		await flushMacrotask()
		const fail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com/reuse', fail })

		expect(task).toBeDefined()
		expect(fail).not.toHaveBeenCalled()
	})
})

describe('JS 层不代填参数默认值', () => {
	it.each([
		'header',
		'protocols',
		'tcpNoDelay',
		'perMessageDeflate',
		'forceCellularNetwork',
	])('没传 %s 时不出现在下发给 native 的参数里', (name) => {
		api.connect({ url: 'wss://example.com' })

		expect(api.lastParamsOf('connectSocket')).not.toHaveProperty(name)
	})

	it('传了的可选参数原样下发', () => {
		api.connect({
			url: 'wss://example.com',
			protocols: ['chat'],
			tcpNoDelay: true,
			perMessageDeflate: true,
			forceCellularNetwork: true,
		})

		const params = api.lastParamsOf('connectSocket')
		expect(params.protocols).toEqual(['chat'])
		expect(params.tcpNoDelay).toBe(true)
		expect(params.perMessageDeflate).toBe(true)
		expect(params.forceCellularNetwork).toBe(true)
	})

	it.each([
		['不传', undefined],
		['字符串 "16"', '16'],
		['布尔 true', true],
		['数组', [16]],
		['null', null],
	])('timeout %s 时归 0', (_case, timeout) => {
		api.connect({ url: 'wss://example.com', timeout })

		expect(api.lastParamsOf('connectSocket').timeout).toBe(0)
	})

	it('timeout 是合法 number 时原样透传', () => {
		api.connect({ url: 'wss://example.com', timeout: 5000 })

		expect(api.lastParamsOf('connectSocket').timeout).toBe(5000)
	})

	// 非有限数不能穿透到桥：Android 走 JSON 桥会把 NaN/Infinity 变成 null 当「没传」，
	// iOS 走 JSValue 桥原样保留后命中 invalid timeout 直接拒连，同一份代码两端结局相反。
	// 判据必须是 Number.isFinite，只查 typeof 挡不住（typeof NaN === 'number'）。
	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
	])('timeout 是 %s 这类非有限数时归 0，不穿透到桥', (_case, timeout) => {
		api.connect({ url: 'wss://example.com', timeout })

		expect(api.lastParamsOf('connectSocket').timeout).toBe(0)
	})
})

describe('header 处理', () => {
	it.each([
		['字符串', 'X-A: 1'],
		['数字', 1],
		['布尔', true],
	])('header 是%s时被静默丢弃，不下发也不报错', (_case, header) => {
		const fail = vi.fn()

		api.connect({ url: 'wss://example.com', header, fail })

		expect(api.lastParamsOf('connectSocket')).not.toHaveProperty('header')
		expect(fail).not.toHaveBeenCalled()
	})

	it('值按 Object.prototype.toString.apply 归一化：string 原样、number 转串、其余取 [object X]', () => {
		api.connect({
			url: 'wss://example.com',
			header: {
				'X-Str': 'v',
				'X-Num': 1,
				'X-Arr': [1, 2],
				'X-Obj': { a: 1 },
				'X-Null': null,
				'X-Undef': undefined,
				'X-Bool': true,
			},
		})

		expect(api.lastParamsOf('connectSocket').header).toEqual({
			'X-Str': 'v',
			'X-Num': '1',
			'X-Arr': '[object Array]',
			'X-Obj': '[object Object]',
			'X-Null': '[object Null]',
			'X-Undef': '[object Undefined]',
			'X-Bool': '[object Boolean]',
		})
	})

	it('只是大小写不同的键不做折叠去重，两条都原样下发', () => {
		api.connect({
			url: 'wss://example.com',
			header: { 'X-Token': 'a', 'x-token': 'b' },
		})

		expect(api.lastParamsOf('connectSocket').header).toEqual({ 'X-Token': 'a', 'x-token': 'b' })
	})

	// typeof [] === 'object'，所以数组不落进「非 object 静默丢弃」那条，继续按
	// Object.keys 归一化成对象映射。
	it.each([
		[['x'], { 0: 'x' }],
		[[], {}],
	])('header 传数组 %j 时归一化成对象映射 %j', (header, expected) => {
		api.connect({ url: 'wss://example.com', header })

		expect(api.lastParamsOf('connectSocket').header).toEqual(expected)
	})

	// typeof null === 'object'，同样不被丢弃；但 null 是假值，归一化结果保持空对象。
	it('header 传 null 时下发空对象', () => {
		api.connect({ url: 'wss://example.com', header: null })

		expect(api.lastParamsOf('connectSocket').header).toEqual({})
	})

	it('不注入 Origin', () => {
		api.connect({ url: 'wss://example.com', header: { 'X-A': 'v' } })

		const { header } = api.lastParamsOf('connectSocket')
		expect(Object.keys(header).map(name => name.toLowerCase())).not.toContain('origin')
	})
})
