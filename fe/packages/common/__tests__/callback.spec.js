import { beforeEach, describe, expect, it, vi } from 'vitest'
import callback from '../src/core/callback'

beforeEach(() => {
	callback.clear()
})

describe('一次性回调', () => {
	it('store 之后 invoke 会带参数调用，且只触发一次', () => {
		const fn = vi.fn()
		const id = callback.store(fn)

		callback.invoke(id, { foo: 'bar' })
		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith({ foo: 'bar' })

		callback.invoke(id, { foo: 'baz' })
		expect(fn).toHaveBeenCalledTimes(1)
	})
})

describe('常驻回调', () => {
	it('可以被多次 invoke，remove 之后不再触发', () => {
		const fn = vi.fn()
		const id = callback.store(fn, true)

		callback.invoke(id, 1)
		callback.invoke(id, 2)
		expect(fn).toHaveBeenCalledTimes(2)

		callback.remove(id)
		callback.invoke(id, 3)
		expect(fn).toHaveBeenCalledTimes(2)
	})

	it('同一个函数重复登记为常驻回调，返回同一个 id，且只会被触发一次', () => {
		const fn = vi.fn()
		const id1 = callback.store(fn, true)
		const id2 = callback.store(fn, true)

		expect(id2).toBe(id1)

		callback.invoke(id1, 'x')
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('remove 之后再次 store 同一个函数，能拿到一个新的可用 id', () => {
		const fn = vi.fn()
		const id1 = callback.store(fn, true)

		callback.remove(id1)

		const id2 = callback.store(fn, true)
		expect(id2).toBeTruthy()

		callback.invoke(id2, 'y')
		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith('y')
	})
})

describe('remove 不带参数或传空值时不清空全表', () => {
	it('remove() 不带参数时，已登记的常驻和一次性回调都还能被触发', () => {
		const fnA = vi.fn()
		const fnB = vi.fn()
		const fnOnce = vi.fn()

		const idA = callback.store(fnA, true)
		const idB = callback.store(fnB, true)
		const idOnce = callback.store(fnOnce)

		callback.remove()

		callback.invoke(idA, 1)
		callback.invoke(idB, 2)
		callback.invoke(idOnce, 3)

		expect(fnA).toHaveBeenCalledWith(1)
		expect(fnB).toHaveBeenCalledWith(2)
		expect(fnOnce).toHaveBeenCalledWith(3)
	})

	it.each([undefined, null, ''])('remove(%p) 同样不能误删任何记录', (emptyValue) => {
		const fnA = vi.fn()
		const fnOnce = vi.fn()

		const idA = callback.store(fnA, true)
		const idOnce = callback.store(fnOnce)

		callback.remove(emptyValue)

		callback.invoke(idA, 'a')
		callback.invoke(idOnce, 'b')

		expect(fnA).toHaveBeenCalledWith('a')
		expect(fnOnce).toHaveBeenCalledWith('b')
	})
})

describe('clear', () => {
	it('清空之后，之前所有的常驻和一次性回调 id 都不再触发', () => {
		const fnKeep = vi.fn()
		const fnOnce = vi.fn()

		const idKeep = callback.store(fnKeep, true)
		const idOnce = callback.store(fnOnce)

		callback.clear()

		callback.invoke(idKeep, 1)
		callback.invoke(idOnce, 2)

		expect(fnKeep).not.toHaveBeenCalled()
		expect(fnOnce).not.toHaveBeenCalled()
	})
})

describe('异常处理', () => {
	it('一次性回调抛异常：异常会往外抛，但记录已被摘除，不会被第二次执行', () => {
		let callCount = 0
		const fn = () => {
			callCount += 1
			throw new Error('boom')
		}
		const id = callback.store(fn)

		expect(() => callback.invoke(id, 1)).toThrow('boom')
		expect(callCount).toBe(1)

		// 记录已经被摘掉，再 invoke 不应该再执行到这个函数（也就不会再抛异常）
		expect(() => callback.invoke(id, 2)).not.toThrow()
		expect(callCount).toBe(1)
	})

	it('常驻回调抛异常：异常往外抛，但记录保留，之后还能继续触发', () => {
		let callCount = 0
		const fn = () => {
			callCount += 1
			throw new Error('boom')
		}
		const id = callback.store(fn, true)

		expect(() => callback.invoke(id, 1)).toThrow('boom')
		expect(callCount).toBe(1)

		expect(() => callback.invoke(id, 2)).toThrow('boom')
		expect(callCount).toBe(2)
	})

	it('一次性回调在执行过程中用同一个 id 再次 invoke，不会重入触发第二次', () => {
		let callCount = 0
		const id = callback.store((...args) => {
			callCount += 1
			// 在自己执行期间，尝试用同一个 id 再触发一次
			callback.invoke(id, args)
		})

		callback.invoke(id, 'first')
		expect(callCount).toBe(1)
	})
})

describe('未登记或空 id 的 invoke', () => {
	it('invoke 一个从未登记过的 id 不抛异常', () => {
		expect(() => callback.invoke('never-registered-id', 1)).not.toThrow()
	})

	it('invoke(undefined) 不抛异常', () => {
		expect(() => callback.invoke(undefined, 1)).not.toThrow()
	})
})

describe('调用方指定 id', () => {
	it('store(fn, false, evtId) 使用调用方给出的 id', () => {
		const fn = vi.fn()
		const id = callback.store(fn, false, '指定的id')

		expect(id).toBe('指定的id')

		callback.invoke('指定的id', 'payload')
		expect(fn).toHaveBeenCalledWith('payload')
	})
})

describe('evtId 覆盖之后的反查索引一致性', () => {
	it('用新函数覆盖 evtId 后，旧函数按 keep 重新 store，应该拿到不同于 evtId 的新 id，且这个新 id 只触发旧函数', () => {
		const fnA = vi.fn()
		const fnB = vi.fn()

		callback.store(fnA, true, 'evt-x')
		callback.store(fnB, true, 'evt-x')

		const newId = callback.store(fnA, true)
		expect(newId).not.toBe('evt-x')

		callback.invoke(newId, 'payload')
		expect(fnA).toHaveBeenCalledWith('payload')
		expect(fnB).not.toHaveBeenCalled()
	})

	it('覆盖之后 invoke(evtId) 只触发新函数，不触发被覆盖的旧函数', () => {
		const fnA = vi.fn()
		const fnB = vi.fn()

		callback.store(fnA, true, 'evt-x')
		callback.store(fnB, true, 'evt-x')

		callback.invoke('evt-x', 'payload')
		expect(fnB).toHaveBeenCalledWith('payload')
		expect(fnA).not.toHaveBeenCalled()
	})

	it('覆盖方是非常驻回调时，旧函数按 keep 重新 store 依然能拿到可用的新 id', () => {
		const fnA = vi.fn()
		const fnB = vi.fn()

		callback.store(fnA, true, 'evt-y')
		callback.store(fnB, false, 'evt-y')

		const newId = callback.store(fnA, true)
		expect(newId).toBeTruthy()
		expect(newId).not.toBe('evt-y')

		callback.invoke(newId, 'payload')
		expect(fnA).toHaveBeenCalledWith('payload')
	})

	it('remove(evtId) 之后，曾经共用过这个 evtId 的函数重新 store 依然能拿到可用的新 id', () => {
		const fnA = vi.fn()
		const fnB = vi.fn()

		callback.store(fnA, true, 'evt-z')
		callback.store(fnB, true, 'evt-z')
		callback.remove('evt-z')

		const newId = callback.store(fnB, true)
		expect(newId).toBeTruthy()

		callback.invoke(newId, 'payload')
		expect(fnB).toHaveBeenCalledWith('payload')
	})
})

describe('显式 evtId 允许 falsy 值，invoke/remove 必须对它一致生效', () => {
	it('store(fn, false, 0)：0 是一次性回调的 id，invoke(0) 两次只触发一次', () => {
		const fn = vi.fn()
		const id = callback.store(fn, false, 0)
		expect(id).toBe(0)

		callback.invoke(0, 'a')
		callback.invoke(0, 'b')

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith('a')
	})

	it('store(fn, true, 0)：remove(0) 之后 invoke(0) 不再触发', () => {
		const fn = vi.fn()
		const id = callback.store(fn, true, 0)
		expect(id).toBe(0)

		callback.remove(0)
		callback.invoke(0, 'x')

		expect(fn).not.toHaveBeenCalled()
	})

	it('store(fn, false, false)：false 是一次性回调的 id，invoke(false) 两次只触发一次', () => {
		const fn = vi.fn()
		const id = callback.store(fn, false, false)
		expect(id).toBe(false)

		callback.invoke(false, 'a')
		callback.invoke(false, 'b')

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith('a')
	})

	it('store(fn, true, false)：remove(false) 之后 invoke(false) 不再触发', () => {
		const fn = vi.fn()
		const id = callback.store(fn, true, false)
		expect(id).toBe(false)

		callback.remove(false)
		callback.invoke(false, 'x')

		expect(fn).not.toHaveBeenCalled()
	})
})

describe('显式 evtId 为空字符串时，remove 必须和 invoke 一致生效', () => {
	it('store(fn, false, \'\')：\'\' 是一次性回调的 id，invoke(\'\') 两次只触发一次', () => {
		const fn = vi.fn()
		const id = callback.store(fn, false, '')
		expect(id).toBe('')

		callback.invoke('', 'a')
		callback.invoke('', 'b')

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith('a')
	})

	it('store(fn, true, \'\')：remove(\'\') 之后 invoke(\'\') 不再触发', () => {
		const fn = vi.fn()
		const id = callback.store(fn, true, '')
		expect(id).toBe('')

		callback.remove('')
		callback.invoke('', 'x')

		expect(fn).not.toHaveBeenCalled()
	})
})

describe('null 当显式 id 传进来时按没给处理', () => {
	it('store(fn, false, null) 拿到的是自动生成的 id，一次性语义正常，不会被反复触发', () => {
		const fn = vi.fn()
		const id = callback.store(fn, false, null)

		expect(id).not.toBeNull()

		callback.invoke(id, 'first')
		callback.invoke(id, 'second')
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('store(fn, true, null) 之后 remove 拿到的 id 能正常摘掉', () => {
		const fn = vi.fn()
		const id = callback.store(fn, true, null)

		callback.remove(id)

		callback.invoke(id, 'payload')
		expect(fn).not.toHaveBeenCalled()
	})
})

describe('clear() 必须连内部的函数反查索引一起清空', () => {
	it('clear() 之后，同一个常驻函数重新 store 要拿到一个不同于清空前的新 id，且新 id 能触发到 fn', () => {
		const fn = vi.fn()
		const oldId = callback.store(fn, true)

		callback.clear()

		const newId = callback.store(fn, true)
		expect(newId).toBeTruthy()
		expect(newId).not.toBe(oldId)

		callback.invoke(newId, 'payload')
		expect(fn).toHaveBeenCalledWith('payload')
	})
})
