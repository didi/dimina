import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FontFaceRegistry } from '../src/core/font-face'
import fonts from '../src/core/font-face'
import { loadFontFace } from '../src/api/core/ui/font'
import api from '../src/api'

const definition = { family: 'Brand', source: 'url("dimina-font://brand")', global: true }

describe('font loading across page lifetimes', () => {
	let registry, send
	beforeEach(() => {
		send = vi.fn()
		registry = new FontFaceRegistry(send)
	})
	function acknowledge(index = send.mock.calls.length - 1, error) {
		const { body } = send.mock.calls[index][0]
		registry.settle({ bridgeId: body.bridgeId, requestId: body.params.requestId, error })
	}

	it('queues App.onLaunch calls until the render resource handshake and replays to future pages', async () => {
		registry.beginPage('first')
		const loaded = registry.load(definition, 'first')
		expect(send).not.toHaveBeenCalled()
		const prepared = registry.preparePage('first')
		expect(send).toHaveBeenCalledTimes(1)
		let ready = false
		prepared.then(() => { ready = true })
		await Promise.resolve()
		expect(ready).toBe(false)
		acknowledge()
		await loaded
		await prepared
		registry.beginPage('next')
		const next = registry.preparePage('next')
		expect(send).toHaveBeenCalledTimes(2)
		expect(send.mock.calls[1][0].body.bridgeId).toBe('next')
		acknowledge()
		await next
	})

	it('updates all existing pages and waits for every target acknowledgement', async () => {
		registry.preparePage('one')
		registry.preparePage('two')
		const loaded = registry.load(definition, 'one')
		let settled = false
		loaded.then(() => { settled = true })
		acknowledge(0)
		await Promise.resolve()
		expect(settled).toBe(false)
		acknowledge(1)
		await loaded
		expect(settled).toBe(true)
	})

	it('replays global definitions to a new document', async () => {
		registry.preparePage('one')
		const loaded = registry.load(definition, 'one')
		acknowledge()
		await loaded
		registry.beginPage('two')
		const prepared = registry.preparePage('two')
		expect(send).toHaveBeenCalledTimes(2)
		acknowledge()
		await prepared
	})

	it('does not wait for a sibling whose render resources are still loading', async () => {
		registry.beginPage('prefetched')
		registry.preparePage('current')
		const loaded = registry.load(definition, 'current')
		expect(send).toHaveBeenCalledTimes(1)
		acknowledge()
		await loaded
		const prepared = registry.preparePage('prefetched')
		expect(send).toHaveBeenCalledTimes(2)
		acknowledge()
		await prepared
	})

	it('keeps local fonts out of sibling and future pages and coalesces duplicate calls', async () => {
		registry.preparePage('one')
		const first = registry.load({ ...definition, global: false }, 'one')
		const second = registry.load({ ...definition, global: false }, 'one')
		expect(send).toHaveBeenCalledTimes(1)
		acknowledge()
		await Promise.all([first, second])
		expect(registry.preparePage('two')).toBeUndefined()
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('rejects unloaded requests and ignores their late result, allowing the same ID to be reused', async () => {
		registry.preparePage('one')
		const first = registry.load(definition, 'one')
		const rejection = expect(first).rejects.toThrow('page unloaded')
		registry.removePage('one')
		await rejection
		registry.preparePage('one')
		const second = registry.load(definition, 'one')
		acknowledge(0)
		expect(registry.requests.size).toBe(1)
		acknowledge(1)
		await second
	})

	it('removes failed global fonts, retries failures, and isolates separate mini programs', async () => {
		registry.preparePage('one')
		const first = registry.load(definition, 'one')
		const rejection = expect(first).rejects.toThrow('font missing')
		acknowledge(0, 'font missing')
		await rejection
		expect(registry.globals.size).toBe(0)
		const retry = registry.load(definition, 'one')
		acknowledge(1)
		await retry
		const other = new FontFaceRegistry(vi.fn())
		expect(other.preparePage('other-app')).toBeUndefined()
		expect(other.globals.size).toBe(0)
	})

	it('sends a new request when a family is replaced and later restored', async () => {
		registry.preparePage('one')
		for (const source of [definition.source, 'url("dimina-font://second")', definition.source]) {
			const loaded = registry.load({ ...definition, source }, 'one')
			acknowledge()
			await loaded
		}
		expect(send).toHaveBeenCalledTimes(3)
	})

	it.each([
		{ family: '', source: 'url(font.ttf)' },
		{ ...definition, source: 'url("dimina-font://../private")' },
		{ ...definition, scopes: ['native'] },
		{ ...definition, global: 'true' },
		{ ...definition, desc: 'bold' },
	])('rejects invalid options before sending a message: %j', async (options) => {
		await expect(registry.load(options, 'one')).rejects.toThrow()
		expect(send).not.toHaveBeenCalled()
	})
})

describe('public wx.loadFontFace contract', () => {
	beforeEach(() => vi.restoreAllMocks())
	it('is enumerable and returns a Promise without callbacks', async () => {
		vi.spyOn(fonts, 'load').mockResolvedValue()
		expect(Object.keys(api)).toContain('loadFontFace')
		expect(api.canIUse('loadFontFace')).toBe(true)
		await expect(loadFontFace(definition)).resolves.toEqual({ status: 'loaded', errMsg: 'loadFontFace:ok' })
	})
	it('calls fail and complete exactly once for failures', async () => {
		vi.spyOn(fonts, 'load').mockRejectedValue(new Error('missing'))
		const fail = vi.fn(), success = vi.fn(), complete = vi.fn()
		expect(loadFontFace({ ...definition, fail, success, complete })).toBeUndefined()
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
		expect(fail).toHaveBeenCalledExactlyOnceWith({ status: 'failed', errMsg: 'loadFontFace:fail missing' })
		expect(success).not.toHaveBeenCalled()
	})
})
