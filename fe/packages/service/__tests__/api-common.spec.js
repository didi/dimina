import { describe, expect, it, vi } from 'vitest'

async function loadCommonApi() {
	vi.resetModules()
	globalThis.DiminaServiceBridge = {
		onMessage: null,
		invoke: vi.fn(() => 'invoke-result'),
		publish: vi.fn(() => 'publish-result'),
	}

	const [{ invokeAPI }, { callback }] = await Promise.all([
		import('../src/api/common/index.js'),
		import('@dimina/common'),
	])

	return {
		callback,
		invokeAPI,
		bridge: globalThis.DiminaServiceBridge,
	}
}

describe('invokeAPI promise-like behavior', () => {
	it('resolves with the success callback payload', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()

		const promise = invokeAPI('showModal', { title: 'Confirm' })
		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: 'showModal:ok', confirm: true }

		expect(promise).toBeInstanceOf(Promise)
		expect(params.title).toBe('Confirm')
		expect(params.success).toEqual(expect.any(String))
		expect(params.fail).toEqual(expect.any(String))

		callback.invoke(params.success, result)

		await expect(promise).resolves.toEqual(result)
	})

	it('rejects with the fail callback payload', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()

		const promise = invokeAPI('showModal', { title: 'Confirm' })
		const params = bridge.invoke.mock.calls[0][0].body.params
		const error = { errMsg: 'showModal:fail cancel' }
		const expectation = expect(promise).rejects.toEqual(error)

		callback.invoke(params.fail, error)

		await expectation
	})

	it('returns a promise for optional-parameter APIs called without args', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()

		const promise = invokeAPI('getNetworkType')
		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: 'getNetworkType:ok', networkType: 'wifi' }

		expect(promise).toBeInstanceOf(Promise)
		expect(params).toEqual({
			success: expect.any(String),
			fail: expect.any(String),
		})

		callback.invoke(params.success, result)

		await expect(promise).resolves.toEqual(result)
	})

	it('does not promise-wrap task-style APIs', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		const result = invokeAPI('request', { url: 'https://example.com' })
		const params = bridge.invoke.mock.calls[0][0].body.params

		expect(result).toBe('invoke-result')
		expect(params).toEqual({ url: 'https://example.com' })
	})

	it('does not promise-wrap sync APIs called without args', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		const result = invokeAPI('clearStorageSync')
		const params = bridge.invoke.mock.calls[0][0].body.params

		expect(result).toBe('invoke-result')
		expect(params).toBeUndefined()
	})

	it('preserves the event id that identifies extension subscriptions', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		invokeAPI('ExampleModule_onChange', {
			evtId: 'ExampleModule_onChange',
			keep: true,
			success: vi.fn(),
		})

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params).toEqual({
			evtId: 'ExampleModule_onChange',
			success: 'ExampleModule_onChange',
		})
	})
})

describe('invokeAPI success/fail/complete callback handling', () => {
	it('registers a function passed as success and can invoke it back through the callback registry', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()

		invokeAPI('connectSocket', { url: 'wss://example.com', success })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.success).toEqual(expect.any(String))

		const result = { errMsg: 'connectSocket:ok' }
		callback.invoke(params.success, result)
		expect(success).toHaveBeenCalledWith(result)
	})

	it('registers a function passed as fail and can invoke it back through the callback registry', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const fail = vi.fn()

		invokeAPI('connectSocket', { url: 'wss://example.com', fail })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.fail).toEqual(expect.any(String))

		const error = { errMsg: 'connectSocket:fail' }
		callback.invoke(params.fail, error)
		expect(fail).toHaveBeenCalledWith(error)
	})

	it('registers a function passed as complete and can invoke it back through the callback registry', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const complete = vi.fn()

		invokeAPI('connectSocket', { url: 'wss://example.com', complete })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.complete).toEqual(expect.any(String))

		const result = { errMsg: 'connectSocket:ok' }
		callback.invoke(params.complete, result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('passes a non-function success value through unchanged instead of dropping it', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		invokeAPI('connectSocket', { url: 'wss://example.com', success: 'already-registered-id' })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.success).toBe('already-registered-id')
	})

	it('passes a non-function fail value through unchanged instead of dropping it', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		invokeAPI('connectSocket', { url: 'wss://example.com', fail: 'already-registered-id' })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.fail).toBe('already-registered-id')
	})

	it('passes a non-function complete value through unchanged instead of dropping it', async () => {
		const { bridge, invokeAPI } = await loadCommonApi()

		invokeAPI('connectSocket', { url: 'wss://example.com', complete: 'already-registered-id' })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.complete).toBe('already-registered-id')
	})

	it('handles a mix of function and id-string callbacks independently without interference', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		const complete = vi.fn()

		invokeAPI('connectSocket', {
			url: 'wss://example.com',
			success,
			fail: 'preregistered-fail-id',
			complete,
		})

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.success).toEqual(expect.any(String))
		expect(params.fail).toBe('preregistered-fail-id')
		expect(params.complete).toEqual(expect.any(String))

		callback.invoke(params.success, { errMsg: 'connectSocket:ok' })
		expect(success).toHaveBeenCalledWith({ errMsg: 'connectSocket:ok' })

		callback.invoke(params.complete, { errMsg: 'connectSocket:ok' })
		expect(complete).toHaveBeenCalledWith({ errMsg: 'connectSocket:ok' })
	})
})
