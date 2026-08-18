import { describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

/**
 * 调用方传进来的 options 是普通 JS 对象，读它的字段会触发 getter，getter 可以抛。
 * 脚本层在读这些字段之前不能先改自己的状态——抛出之后没有任何一条路径会来收尾，
 * 改了的状态就永久留在那里。
 *
 * 这不是「防御恶意小程序」：`Object.defineProperty` 加一个会抛的 getter 是业务代码里
 * 真实会出现的写法（惰性字段、代理对象、被框架包过的 props），而后果是整个小程序在
 * 剩余生命周期里失去全局 socket 接口，或者认为一条其实还开着的连接已经关了。
 */

function throwingGetter(key, message) {
	const options = {}
	Object.defineProperty(options, key, {
		enumerable: true,
		get() {
			throw new Error(message)
		},
	})
	return options
}

describe('抛异常的 options getter 不会留下坏掉的脚本层状态', () => {
	it('connectSocket 读 header 抛出后，全局绑定仍然能被下一条连接拿到', async () => {
		const api = await loadSocketApi()

		const hostile = throwingGetter('header', 'header getter boom')
		hostile.url = 'wss://example.com/first'
		expect(() => api.connectSocket(hostile)).toThrow('header getter boom')

		// 这条连接从未发给 native，也就永远不会有终态事件来把它从绑定上摘下来。
		expect(api.paramsOf('connectSocket')).toHaveLength(0)

		// 下一条连接必须成为当前连接：全局 send 要落到它的 socketId 上。
		const handle = api.openConnection('wss://example.com/second')
		api.sendSocketMessage({ data: 'ping' })
		expect(api.lastParamsOf('sendSocketMessage').socketId).toBe(handle.socketId)
	})

	// header 之外的字段同样是先读后用：timeout 走的是另一条读取分支，单独钉一次，
	// 免得日后只在 header 那条路上做防护。
	it('connectSocket 读 timeout 抛出后，全局绑定同样没有被钉住', async () => {
		const api = await loadSocketApi()

		const hostile = throwingGetter('timeout', 'timeout getter boom')
		hostile.url = 'wss://example.com/first'
		expect(() => api.connectSocket(hostile)).toThrow('timeout getter boom')
		expect(api.paramsOf('connectSocket')).toHaveLength(0)

		const handle = api.openConnection('wss://example.com/second')
		api.sendSocketMessage({ data: 'ping' })
		expect(api.lastParamsOf('sendSocketMessage').socketId).toBe(handle.socketId)

		// 这条从未发起的连接不应留下名额；后续仍可占满 5 条。
		for (let i = 0; i < 4; i++) {
			api.openConnection(`wss://example.com/n${i}`)
		}
		const fail = vi.fn()
		api.connectSocket({ url: 'wss://example.com/sixth', fail })
		expect(fail).toHaveBeenCalledTimes(1)
		expect(fail.mock.calls[0][0].errMsg)
			.toBe('connectSocket:fail fail reach max websocket connect count 5')
	})

	it('connectSocket 也在下发前读取 fail，getter 抛出不会延迟到异步失败回调', async () => {
		const api = await loadSocketApi()
		const hostile = throwingGetter('fail', 'fail getter boom')
		hostile.url = 'wss://example.com/first'

		expect(() => api.connectSocket(hostile)).toThrow('fail getter boom')
		expect(api.paramsOf('connectSocket')).toHaveLength(0)

		const handle = api.openConnection('wss://example.com/second')
		api.sendSocketMessage({ data: 'ping' })
		expect(api.lastParamsOf('sendSocketMessage').socketId).toBe(handle.socketId)
	})

	it('connectSocket 对每个可选字段只读取一次', async () => {
		const api = await loadSocketApi()
		const reads = {}
		const options = { url: 'wss://example.com' }
		const values = {
			timeout: 1000,
			header: { 'X-Test': 'value' },
			protocols: ['chat'],
			tcpNoDelay: true,
			perMessageDeflate: false,
			forceCellularNetwork: false,
			success: vi.fn(),
			fail: vi.fn(),
			complete: vi.fn(),
		}
		for (const [key, value] of Object.entries(values)) {
			Object.defineProperty(options, key, {
				get() {
					reads[key] = (reads[key] || 0) + 1
					return value
				},
			})
		}

		api.connectSocket(options)
		expect(reads).toEqual(Object.fromEntries(Object.keys(values).map(key => [key, 1])))
	})

	it('options getter 重入 connectSocket 也不能绕过 5 条上限', async () => {
		const api = await loadSocketApi()
		const nestedFailures = []
		const options = { url: 'wss://example.com/outer' }
		Object.defineProperty(options, 'timeout', {
			get() {
				for (let index = 0; index < 5; index++) {
					api.connectSocket({
						url: `wss://example.com/nested-${index}`,
						fail: error => nestedFailures.push(error.errMsg),
					})
				}
				return 1000
			},
		})

		api.connectSocket(options)

		expect(api.paramsOf('connectSocket')).toHaveLength(5)
		expect(nestedFailures).toEqual(['connectSocket:fail fail reach max websocket connect count 5'])
	})

	// 超并发在读任何可选参数之前返回，因此 hostile getter 不应执行。
	it('超并发时不读可选参数，照常返回已封存任务并走 fail', async () => {
		const api = await loadSocketApi()
		for (let i = 0; i < 5; i++) {
			api.openConnection(`wss://example.com/n${i}`)
		}

		const fail = vi.fn()
		const hostile = throwingGetter('timeout', 'timeout getter boom')
		hostile.url = 'wss://example.com/sixth'
		hostile.fail = fail

		const task = api.connectSocket(hostile)

		expect(task).toBeDefined()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(fail.mock.calls[0][0].errMsg)
			.toBe('connectSocket:fail fail reach max websocket connect count 5')
		expect(api.paramsOf('connectSocket')).toHaveLength(5)
	})

	// 契约是「header 的键名不做任何加工」。`__proto__` 是普通对象上唯一会走继承 setter 的
	// 键名，写进去既不报错也不落成自有字段，这个头就凭空没了——而 header 常常来自服务端
	// 下发的 JSON，`JSON.parse` 造出来的正是自有的 `__proto__` 键。
	it('名为 __proto__ 的 header 字段照常下发，不会被原型 setter 吞掉', async () => {
		const api = await loadSocketApi()

		const header = JSON.parse('{"__proto__": "sentinel", "X-Normal": "v"}')
		const handle = api.connect({ url: 'wss://example.com', header })

		expect(handle.params.header['X-Normal']).toBe('v')
		const own = Object.getOwnPropertyDescriptor(handle.params.header, '__proto__')
		expect(own).toBeDefined()
		expect(own.value).toBe('sentinel')
		// 桥上传的是 JSON，序列化后这个字段也必须还在。
		const roundTripped = JSON.parse(JSON.stringify(handle.params.header))
		expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')?.value).toBe('sentinel')
	})

	it('closeSocket 读 code 抛出时，连接不会被脚本层单方面记成已关闭', async () => {
		const api = await loadSocketApi()

		const handle = api.openConnection('wss://example.com/only')

		const hostile = throwingGetter('code', 'close code getter boom')
		expect(() => api.closeSocket(hostile)).toThrow('close code getter boom')

		// native 没收到 closeSocket，内部状态不能单方面关闭。
		expect(api.paramsOf('closeSocket')).toHaveLength(0)

		// 状态没坏的证据：紧接着一次正常的 closeSocket 仍然照常发得出去。
		api.closeSocket({})
		expect(api.lastParamsOf('closeSocket').socketId).toBe(handle.socketId)
	})

	it.each(['success', 'fail', 'complete'])(
		'closeSocket 读 %s 抛出时同样回滚乐观 CLOSED',
		async (key) => {
			const api = await loadSocketApi()
			const handle = api.openConnection('wss://example.com/only')
			const hostile = throwingGetter(key, `${key} getter boom`)

			expect(() => api.closeSocket(hostile)).toThrow(`${key} getter boom`)
			expect(api.paramsOf('closeSocket')).toHaveLength(0)

			api.closeSocket({})
			expect(api.lastParamsOf('closeSocket').socketId).toBe(handle.socketId)
		},
	)
})
