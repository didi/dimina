import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

function fixture() {
	const values = new Map<string, string>()
	const adapter = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value) },
		removeItem: (key: string) => { values.delete(key) },
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() { return values.size },
	}
	const app = Object.create(MiniApp.prototype) as MiniApp
	Object.defineProperty(app, 'appId', { value: 'quota' })
	Object.assign(app, { parent: { storageAdapter: adapter }, jscore: { postMessage: vi.fn() } })
	const call = (method: string, options: Record<string, unknown> = {}) => {
		const post = (app.jscore.postMessage as ReturnType<typeof vi.fn>)
		post.mockClear()
		;(app[method as keyof MiniApp] as (options: unknown) => void).call(app, { ...options, success: 'ok', fail: 'fail', complete: 'complete' })
		const messages = post.mock.calls.map(([message]) => message.body)
		return { result: messages.find(message => message.id !== 'complete'), complete: messages.at(-1) }
	}
	return { app, values, call }
}

describe('WeChat logical storage quota', () => {
	it('persists only the serialized value and does not evaluate toJSON twice', () => {
		const f = fixture()
		const toJSON = vi.fn(() => ({ value: 'x'.repeat(4096) }))
		expect(f.call('setStorage', { key: 'object', data: { toJSON } }).result.id).toBe('ok')
		expect(toJSON).toHaveBeenCalledTimes(1)
		const stored = [...f.values.values()].map(value => JSON.parse(value)).find(value => value.wire)
		expect(stored).not.toHaveProperty('data')
		expect(f.call('getStorage', { key: 'object' }).result.args.data).toEqual({ value: 'x'.repeat(4096) })
	})

	it('does not attempt to JSON serialize unsupported original values after encoding their type', () => {
		const f = fixture()
		expect(f.call('setStorage', { key: 'bigint', data: 1n }).result.id).toBe('ok')
		expect(f.call('getStorage', { key: 'bigint' }).result.args.data).toBe('')
	})

	it('counts typed JSON, keys and escaping in UTF-16 rather than database overhead', () => {
		const f = fixture()
		const key = '键😀'
		const data = '你😀"\\\n'.repeat(100)
		f.call('setStorage', { key, data })
		const expected = JSON.stringify({ [key]: { data, dataType: 'String' } }).length
		const { result, complete } = f.call('getStorageInfo')
		expect(result.args.currentSize).toBe(Math.ceil(expected / 1024))
		expect(result.args.limitSize).toBe(10240)
		expect(complete.args).toEqual(result.args)
	})

	it('rejects an oversized replacement atomically and returns the same failure to complete', () => {
		const f = fixture()
		f.call('setStorage', { key: 'saved', data: 'original' })
		const { result, complete } = f.call('setStorage', { key: 'saved', data: 'x'.repeat(10 * 1024 * 1024) })
		expect(result.id).toBe('fail')
		expect(result.args.errMsg).toBe('setStorage:fail exceed storage max size 10Mb')
		expect(complete.args).toEqual(result.args)
		expect(f.call('getStorage', { key: 'saved' }).result.args.data).toBe('original')
	})

	it('counts a replacement once and releases logical capacity after deletion and clear', () => {
		const f = fixture()
		const data = 'x'.repeat(6 * 1024 * 1024)
		expect(f.call('setStorage', { key: 'large', data }).result.id).toBe('ok')
		expect(f.call('setStorage', { key: 'large', data }).result.id).toBe('ok')
		expect(f.call('setStorage', { key: 'another', data }).result.id).toBe('fail')
		f.call('removeStorage', { key: 'large' })
		expect(f.call('setStorage', { key: 'another', data }).result.id).toBe('ok')
		f.call('clearStorage')
		expect(f.call('getStorageInfo').result.args).toMatchObject({ keys: [], currentSize: 1, limitSize: 10240 })
	})
})
