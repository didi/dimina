import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { offLocationChange, onLocationChange } from '../src/api/core/location/index.js'

function lastParamsOf(apiName) {
	const calls = vi.mocked(invokeAPI).mock.calls.filter(call => call[0] === apiName)
	if (calls.length === 0) {
		throw new Error(`invokeAPI was never called with ${apiName}`)
	}
	return calls[calls.length - 1][1]
}

describe('location change listener registry', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it('onLocationChange 登记监听，原生用该 id 回调时 listener 被调用', () => {
		const listener = vi.fn()
		onLocationChange(listener)

		expect(invokeAPI).toHaveBeenCalledWith('onLocationChange', expect.objectContaining({
			success: expect.any(String),
		}))

		const { success: id } = lastParamsOf('onLocationChange')
		callback.invoke(id, { latitude: 1, longitude: 2 })

		expect(listener).toHaveBeenCalledWith({ latitude: 1, longitude: 2 })
	})

	it('offLocationChange(listener) 移除这一个监听后，原生再回调不再触发 listener', () => {
		const listener = vi.fn()
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		offLocationChange(listener)

		expect(invokeAPI).toHaveBeenCalledWith('offLocationChange', expect.anything())

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('offLocationChange() 不传参数会下发 offLocationChange，且原来登记的监听不再被触发', () => {
		const listener = vi.fn()
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		offLocationChange()

		// 不带 listener 时不带参数下发，语义是「移除全部」
		expect(invokeAPI).toHaveBeenCalledWith('offLocationChange')

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('offLocationChange() 移除全部通过 onLocationChange 登记的监听，但不影响其它接口登记的常驻回调', () => {
		// 模拟另一个接口（比如 WebSocket）登记的常驻监听，跟定位监听共用同一张回调表
		const otherModuleListener = vi.fn()
		const otherModuleId = callback.store(otherModuleListener, true)

		const locationListener = vi.fn()
		onLocationChange(locationListener)
		const { success: locationId } = lastParamsOf('onLocationChange')

		offLocationChange()

		// 关键断言：offLocationChange() 不能把其它模块的常驻回调也摘掉
		callback.invoke(otherModuleId, { some: 'event' })
		expect(otherModuleListener).toHaveBeenCalledWith({ some: 'event' })

		// 同时确认定位自己的监听确实已经被移除
		callback.invoke(locationId, { latitude: 1, longitude: 2 })
		expect(locationListener).not.toHaveBeenCalled()
	})

	it('offLocationChange() 之后再次调用不会重复影响其它模块的监听', () => {
		const otherModuleListener = vi.fn()
		const otherModuleId = callback.store(otherModuleListener, true)

		onLocationChange(vi.fn())
		offLocationChange()
		offLocationChange()

		callback.invoke(otherModuleId, 'x')
		expect(otherModuleListener).toHaveBeenCalledWith('x')
	})
})

describe('常驻回调按函数身份去重，跨接口共用同一张表', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it('同一个函数既被 onLocationChange 登记，又被其它接口登记为常驻回调时，offLocationChange() 不能连带摘掉那个函数在其它接口里的登记', () => {
		const listener = vi.fn()

		onLocationChange(listener)
		// 模拟另一个接口（比如内存告警）把同一个函数对象登记为常驻回调
		const otherId = callback.store(listener, true)

		offLocationChange()

		// 关键断言：其它接口登记的常驻回调必须还能触发到 listener
		callback.invoke(otherId, { level: 10 })
		expect(listener).toHaveBeenCalledWith({ level: 10 })

		// 同时确认定位自己那条监听确实已经被摘掉
		listener.mockClear()
		const { success: locationId } = lastParamsOf('onLocationChange')
		callback.invoke(locationId, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('同一个 listener 连续 onLocationChange 两次之后，offLocationChange(listener) 一次就能摘干净，不会因为重复登记而摘不掉', () => {
		const listener = vi.fn()

		onLocationChange(listener)
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		offLocationChange(listener)

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})
})

describe('桥接同步抛错之后状态要能恢复', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it('onLocationChange 第一次因桥抛错而失败，桥恢复后重试必须真的下发 onLocationChange 并能触发 listener', () => {
		const listener = vi.fn()
		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => onLocationChange(listener)).toThrow()

		onLocationChange(listener)

		const { success: id } = lastParamsOf('onLocationChange')
		expect(id).toBeTruthy()

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).toHaveBeenCalledWith({ latitude: 1, longitude: 2 })
	})

	it('onLocationChange 注册失败那次即使已经生成了回调 id，事后原生用这个 id 回调也不应该触发 listener（不留残留注册）', () => {
		const listener = vi.fn()
		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => onLocationChange(listener)).toThrow()

		// 即使这次调用最终抛错，invokeAPI 的 mock 也记录了传给它的参数（含当时生成的 id）
		const { success: staleId } = lastParamsOf('onLocationChange')

		callback.invoke(staleId, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('offLocationChange(listener) 桥抛错后可以重试，重试成功后才真正下发 offLocationChange，且原 id 不再触发 listener', () => {
		const listener = vi.fn()
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => offLocationChange(listener)).toThrow()

		offLocationChange(listener)

		expect(invokeAPI).toHaveBeenCalledWith('offLocationChange', expect.anything())

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).not.toHaveBeenCalled()
	})
})

describe('非函数入参要被静默忽略', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it.each([
		['对象 {}', {}],
		['字符串', 'listener'],
		['数字', 123],
	])('onLocationChange 收到非函数入参（%s）时静默忽略，不抛异常也不下发 onLocationChange 桥调用', (_label, value) => {
		expect(() => onLocationChange(value)).not.toThrow()

		const onLocationChangeCalls = vi.mocked(invokeAPI).mock.calls.filter(call => call[0] === 'onLocationChange')
		expect(onLocationChangeCalls).toHaveLength(0)
	})

	it('offLocationChange({}) 静默忽略，不抛异常，且不能被当成「不传参数」从而触发全量移除', () => {
		const listener = vi.fn()
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		expect(() => offLocationChange({})).not.toThrow()

		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).toHaveBeenCalledWith({ latitude: 1, longitude: 2 })
	})
})

describe('offLocationChange 只有完全不传参数才移除全部，falsy 无效值也要当成无效入参忽略', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it.each([
		['false', false],
		['0', 0],
		['空字符串', ''],
		['null', null],
	])('offLocationChange(%s) 是无效入参，静默忽略，不下发桥调用，也不移除任何监听', (_label, value) => {
		const listenerA = vi.fn()
		const listenerB = vi.fn()
		onLocationChange(listenerA)
		const { success: idA } = lastParamsOf('onLocationChange')
		onLocationChange(listenerB)
		const { success: idB } = lastParamsOf('onLocationChange')

		vi.mocked(invokeAPI).mockClear()

		expect(() => offLocationChange(value)).not.toThrow()

		expect(invokeAPI).not.toHaveBeenCalled()

		callback.invoke(idA, { latitude: 1, longitude: 2 })
		expect(listenerA).toHaveBeenCalledWith({ latitude: 1, longitude: 2 })

		callback.invoke(idB, { latitude: 3, longitude: 4 })
		expect(listenerB).toHaveBeenCalledWith({ latitude: 3, longitude: 4 })
	})
})

describe('offLocationChange() 全量移除分支的桥抛错重试要对称', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.clear()
	})

	it('offLocationChange() 桥抛错后可以重试，重试成功后才真正摘掉全部监听', () => {
		const listener = vi.fn()
		onLocationChange(listener)
		const { success: id } = lastParamsOf('onLocationChange')

		vi.mocked(invokeAPI).mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => offLocationChange()).toThrow()

		// 桥抛错后内部状态原样保留，监听应该还在
		callback.invoke(id, { latitude: 1, longitude: 2 })
		expect(listener).toHaveBeenCalledWith({ latitude: 1, longitude: 2 })

		listener.mockClear()
		offLocationChange()

		callback.invoke(id, { latitude: 3, longitude: 4 })
		expect(listener).not.toHaveBeenCalled()
	})
})
