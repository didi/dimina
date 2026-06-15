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
})
