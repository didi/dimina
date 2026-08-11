import { describe, expect, it, vi } from 'vitest'
import { loadSocketApi } from './websocket-dimina-harness.js'

/**
 * 桥可以同步抛错。抛在「脚本层已经改过状态、native 还没收到东西」的中间，
 * 或者抛在「native 已经收到、脚本层却要把这次调用当作没发生」的中间，
 * 两边的账本就永久对不上：脚本层记着一条其实还开着的连接已经关了，
 * 或者忘掉一条其实已经在握手的连接。
 *
 * 下发给 native 的 fail 回调接不住这种同步抛出——它只在 native 回来一个失败结果时才跑。
 */

describe('桥同步抛错时脚本层与 native 的账本仍然对得上', () => {
	it('connectSocket 已下发、事件登记才失败时，补一刀 closeSocket 撤销这条连接', async () => {
		const api = await loadSocketApi()
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'onSocketMessage') throw new Error('bridge down')
		})
		const fail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com', fail })

		// 调用方拿到的是「这条连接没建起来」。
		expect(task).toBeUndefined()
		expect(fail).toHaveBeenCalledTimes(1)

		// 但 native 已经收到 connectSocket 了，四个事件一个都没登记成——不撤销的话
		// 这条连接谁也收不到、谁也关不掉，还占着 native 的并发名额。
		const dispatched = api.lastParamsOf('connectSocket')
		expect(api.paramsOf('closeSocket')).toEqual([
			{ socketId: dispatched.socketId, code: 1000 },
		])
	})

	it('connectSocket 自己就没发出去时不补撤销，免得对着 native 没有的 socketId 发关闭', async () => {
		const api = await loadSocketApi()
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'connectSocket') throw new Error('bridge down')
		})
		const fail = vi.fn()

		const task = api.connectSocket({ url: 'wss://example.com', fail })

		expect(task).toBeUndefined()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(api.paramsOf('closeSocket')).toHaveLength(0)
	})

	it('撤销本身再抛错也不外泄，fail 报的仍是最初那个登记失败', async () => {
		const api = await loadSocketApi()
		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'onSocketMessage') throw new Error('register down')
			if (msg.body.name === 'closeSocket') throw new Error('undo down')
		})
		const fail = vi.fn()

		let task
		expect(() => {
			task = api.connectSocket({ url: 'wss://example.com', fail })
		}).not.toThrow()

		expect(task).toBeUndefined()
		expect(fail.mock.calls[0][0].errMsg).toBe('connectSocket:fail register down')
	})

	it('wx.closeSocket 的桥同步抛错时回滚乐观置位，连接不会被记成已关闭', async () => {
		const api = await loadSocketApi()
		const handle = api.openConnection('wss://example.com/only')

		api.bridge.invoke.mockImplementation((msg) => {
			if (msg.body.name === 'closeSocket') throw new Error('bridge down')
		})

		// 异常仍归调用方处理，脚本层不吞。
		expect(() => api.closeSocket({ fail() {} })).toThrow('bridge down')

		// native 什么都没收到，这条连接在传输层上还开着；内部状态若没回滚，
		// 全局接口会错误地报告 not connected。
		api.sendSocketMessage({ data: 'still open' })
		expect(api.paramsForSocket('sendSocketMessage', handle.socketId)).toHaveLength(1)
	})

})
