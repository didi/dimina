import { callback } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStorage, clearStorageSync, getStorage, getStorageSync, removeStorageSync, setStorage, setStorageSync } from '../src/api/core/storage'

describe('storage public contract', () => {
	let records
	beforeEach(() => {
		records = new Map()
		vi.stubGlobal('DiminaServiceBridge', { invoke: vi.fn(({ body: { name, params } }) => {
			if (name === 'setStorageSync') { records.set(params[0], params[2]?.__diminaStorageWire); return true }
			if (name === 'getStorageSync') return { __diminaStorageResult: 1, record: records.get(params.key) }
			if (name === 'setStorage') {
				records.set(params.key, params.__diminaStorageWire)
				callback.invoke(params.success, { errMsg: 'setStorage:ok' })
				return
			}
			if (name === 'getStorage') {
				const result = { data: { __diminaStorageResult: 1, record: records.get(params.key) }, errMsg: 'getStorage:ok' }
				callback.invoke(params.success, result)
				callback.invoke(params.complete, result)
				return
			}
			if (name === 'clearStorage') { callback.invoke(params.success, { errMsg: 'clearStorage:ok' }); return }
			return true
		}) })
	})
	afterEach(() => vi.unstubAllGlobals())

	it('keeps sync mutations void even when an older host returns booleans', () => {
		expect(setStorageSync('key', 1)).toBeUndefined()
		expect(removeStorageSync('key')).toBeUndefined()
		expect(clearStorageSync()).toBeUndefined()
	})

	it.each([new Date(1700000000000), Number.NaN, Number.POSITIVE_INFINITY, { nested: [false, null, '你好😀'] }])('round trips typed storage data %s through the JSON bridge', (value) => {
		setStorageSync('key', value)
		expect(getStorageSync('key')).toEqual(value)
	})

	it('uses the synchronous default empty string for an undefined second argument', () => {
		setStorageSync('key', undefined)
		expect(getStorageSync('key')).toBe('')
	})

	it('decodes both success and complete for callback reads and Promise reads', async () => {
		const value = new Date(1700000000000)
		await setStorage({ key: 'key', data: value })
		const success = vi.fn()
		const complete = vi.fn()
		getStorage({ key: 'key', success, complete })
		expect(success).toHaveBeenCalledWith({ data: value, errMsg: 'getStorage:ok' })
		expect(complete).toHaveBeenCalledWith({ data: value, errMsg: 'getStorage:ok' })
		await expect(getStorage({ key: 'key' })).resolves.toEqual({ data: value, errMsg: 'getStorage:ok' })
	})

	it('throws a synchronous host quota error instead of returning an error object', () => {
		globalThis.DiminaServiceBridge.invoke.mockReturnValue({ __diminaStorageError: 'exceed storage max size 10Mb' })
		expect(() => setStorageSync('key', 'value')).toThrow('setStorageSync:fail exceed storage max size 10Mb')
	})

	it('supports clearStorage callbacks as well as its optional Promise form', async () => {
		const success = vi.fn()
		clearStorage({ success })
		expect(success).toHaveBeenCalledWith({ errMsg: 'clearStorage:ok' })
		await expect(clearStorage()).resolves.toEqual({ errMsg: 'clearStorage:ok' })
	})

	it('reports invalid keys and unserializable values through fail and complete without invoking native', async () => {
		const fail = vi.fn()
		const complete = vi.fn()
		setStorage({ key: 123, data: 'value', fail, complete })
		expect(fail).toHaveBeenCalledWith({ errMsg: 'setStorage:fail parameter.key should be String' })
		expect(complete).toHaveBeenCalledWith(fail.mock.calls[0][0])
		const data = {}; data.self = data
		await expect(setStorage({ key: 'key', data })).rejects.toMatchObject({ errMsg: expect.stringContaining('setStorage:fail') })
		expect(globalThis.DiminaServiceBridge.invoke).not.toHaveBeenCalled()
	})

	it.each(['sync', 'async'])('does not serialize user data a second time when crossing the %s JSON bridge', async (mode) => {
		const invoke = globalThis.DiminaServiceBridge.invoke.getMockImplementation()
		globalThis.DiminaServiceBridge.invoke.mockImplementation(message => invoke(JSON.parse(JSON.stringify(message))))
		const toJSON = vi.fn(() => ({ saved: true }))
		if (mode === 'sync') setStorageSync('key', { toJSON })
		else await setStorage({ key: 'key', data: { toJSON } })
		expect(toJSON).toHaveBeenCalledTimes(1)
		expect(getStorageSync('key')).toEqual({ saved: true })
		if (mode === 'sync') setStorageSync('unsupported', 1n)
		else await setStorage({ key: 'unsupported', data: 1n })
		expect(getStorageSync('unsupported')).toBe('')
	})
})
