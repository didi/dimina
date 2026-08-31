import { describe, expect, it, vi } from 'vitest'

async function loadWindowApi() {
	vi.resetModules()
	globalThis.DiminaServiceBridge = {
		onMessage: null,
		invoke: vi.fn(() => 'invoke-result'),
		publish: vi.fn(() => 'publish-result'),
	}

	const [{ onWindowResize, offWindowResize }, { callback }] = await Promise.all([
		import('../src/api/core/ui/window/index.js'),
		import('@dimina/common'),
	])

	return {
		callback,
		onWindowResize,
		offWindowResize,
		bridge: globalThis.DiminaServiceBridge,
	}
}

function lastParams(bridge) {
	const calls = bridge.invoke.mock.calls
	return calls[calls.length - 1][0].body.params
}

describe('onWindowResize', () => {
	it('stores the listener as a keep callback and forwards its evtId', async () => {
		const { bridge, callback, onWindowResize } = await loadWindowApi()

		const listener = vi.fn()
		onWindowResize(listener)
		const { success: evtId } = lastParams(bridge)

		expect(evtId).toEqual(expect.any(String))
		expect(callback.callbacks[evtId].keep).toBe(true)
		callback.invoke(evtId, { size: { windowWidth: 844, windowHeight: 390 } })
		expect(listener).toHaveBeenCalledWith({ size: { windowWidth: 844, windowHeight: 390 } })
		expect(callback.callbacks[evtId]).toBeDefined()
	})

	it('gets its own evtId even when the listener is already registered by another keep API', async () => {
		const { bridge, callback, onWindowResize } = await loadWindowApi()

		const shared = vi.fn()
		const otherApiEvtId = callback.store(shared, true)
		onWindowResize(shared)

		expect(lastParams(bridge).success).not.toBe(otherApiEvtId)
	})

	it('reuses the same evtId when the same function is registered twice', async () => {
		const { bridge, onWindowResize } = await loadWindowApi()

		const listener = vi.fn()
		onWindowResize(listener)
		const firstEvtId = lastParams(bridge).success
		onWindowResize(listener)
		const secondEvtId = lastParams(bridge).success

		expect(secondEvtId).toBe(firstEvtId)
	})

	it('treats a non-function listener as no listener, without touching the callback store', async () => {
		const { bridge, callback, onWindowResize } = await loadWindowApi()

		onWindowResize(null)
		const params = lastParams(bridge)

		expect(params).toBeUndefined()
		expect(Object.keys(callback.callbacks)).toHaveLength(0)
	})
})

describe('offWindowResize', () => {
	it('removes the stored callback for a previously registered listener', async () => {
		const { bridge, callback, onWindowResize, offWindowResize } = await loadWindowApi()

		const listener = vi.fn()
		onWindowResize(listener)
		const { success: evtId } = lastParams(bridge)
		expect(callback.callbacks[evtId]).toBeDefined()

		offWindowResize(listener)

		expect(callback.callbacks[evtId]).toBeUndefined()
		expect(lastParams(bridge)).toEqual({ success: evtId })
	})

	it('does not create a callback entry for a listener that was never registered', async () => {
		const { bridge, callback, offWindowResize } = await loadWindowApi()

		const neverRegistered = vi.fn()
		const result = offWindowResize(neverRegistered)

		expect(result).toBeUndefined()
		expect(Object.keys(callback.callbacks)).toHaveLength(0)
		expect(bridge.invoke).not.toHaveBeenCalled()
	})

	it('is a no-op the second time it is called for the same listener', async () => {
		const { bridge, onWindowResize, offWindowResize } = await loadWindowApi()

		const listener = vi.fn()
		onWindowResize(listener)
		offWindowResize(listener)
		bridge.invoke.mockClear()

		const result = offWindowResize(listener)

		expect(result).toBeUndefined()
		expect(bridge.invoke).not.toHaveBeenCalled()
	})

	it('clears every registered listener when called without arguments', async () => {
		const { bridge, callback, onWindowResize, offWindowResize } = await loadWindowApi()

		const first = vi.fn()
		const second = vi.fn()
		onWindowResize(first)
		const firstEvtId = lastParams(bridge).success
		onWindowResize(second)
		const secondEvtId = lastParams(bridge).success

		offWindowResize()

		expect(callback.callbacks[firstEvtId]).toBeUndefined()
		expect(callback.callbacks[secondEvtId]).toBeUndefined()
		expect(lastParams(bridge)).toBeUndefined()
	})

	it('leaves listeners registered by other keep APIs untouched when clearing all', async () => {
		const { bridge, callback, onWindowResize, offWindowResize } = await loadWindowApi()

		const unrelatedEvtId = callback.store(vi.fn(), true)
		onWindowResize(vi.fn())

		offWindowResize()

		expect(callback.callbacks[unrelatedEvtId]).toBeDefined()
		expect(bridge.invoke).toHaveBeenCalled()
	})

	it('registering again after off produces a fresh evtId, not a leaked stale one', async () => {
		const { bridge, callback, onWindowResize, offWindowResize } = await loadWindowApi()

		const listener = vi.fn()
		onWindowResize(listener)
		const firstEvtId = lastParams(bridge).success
		offWindowResize(listener)

		onWindowResize(listener)
		const secondEvtId = lastParams(bridge).success

		expect(Object.keys(callback.callbacks)).toEqual([secondEvtId])
		expect(callback.callbacks[firstEvtId]).toBeUndefined()
		callback.invoke(secondEvtId, 'detail')
		expect(listener).toHaveBeenCalledWith('detail')
	})

	it('keeps another keep API listening when the same function was registered on both', async () => {
		const { callback, onWindowResize, offWindowResize } = await loadWindowApi()

		const shared = vi.fn()
		const otherApiEvtId = callback.store(shared, true)
		onWindowResize(shared)

		offWindowResize(shared)

		expect(callback.callbacks[otherApiEvtId]).toBeDefined()
		callback.invoke(otherApiEvtId, 'still-listening')
		expect(shared).toHaveBeenCalledWith('still-listening')
	})
})
