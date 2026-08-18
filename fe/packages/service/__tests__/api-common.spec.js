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

	it.each(['navigateBackMiniProgram', 'exitMiniProgram'])('returns a promise for %s when called without options', async (apiName) => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()

		const promise = invokeAPI(apiName)
		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: `${apiName}:ok` }

		expect(promise).toBeInstanceOf(Promise)
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

describe('invokeAPI success/fail paired cleanup', () => {
	it('invalidates the paired fail id once success fires', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		const fail = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success, fail })

		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: 'showModal:ok' }
		callback.invoke(params.success, result)
		expect(success).toHaveBeenCalledWith(result)

		const error = { errMsg: 'showModal:fail cancel' }
		callback.invoke(params.fail, error)
		expect(fail).not.toHaveBeenCalled()
	})

	it('invalidates the paired success id once fail fires', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		const fail = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success, fail })

		const params = bridge.invoke.mock.calls[0][0].body.params
		const error = { errMsg: 'showModal:fail cancel' }
		callback.invoke(params.fail, error)
		expect(fail).toHaveBeenCalledWith(error)

		const result = { errMsg: 'showModal:ok' }
		callback.invoke(params.success, result)
		expect(success).not.toHaveBeenCalled()
	})

	it('still triggers complete after the success/fail pair is resolved', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		const complete = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success, complete })

		const params = bridge.invoke.mock.calls[0][0].body.params
		callback.invoke(params.success, { errMsg: 'showModal:ok' })

		const completeResult = { errMsg: 'showModal:ok' }
		callback.invoke(params.complete, completeResult)
		expect(complete).toHaveBeenCalledWith(completeResult)
	})

	it('only triggers complete once even when invoked twice', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const complete = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', complete })

		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: 'showModal:ok' }
		callback.invoke(params.complete, result)
		callback.invoke(params.complete, result)

		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('does not error when only success is registered and the success path fires', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()

		expect(() => invokeAPI('showModal', { title: 'Confirm', success })).not.toThrow()

		const params = bridge.invoke.mock.calls[0][0].body.params
		const result = { errMsg: 'showModal:ok' }
		expect(() => callback.invoke(params.success, result)).not.toThrow()
		expect(success).toHaveBeenCalledWith(result)
	})

	it('does not error when only fail is registered and the fail path fires', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const fail = vi.fn()

		expect(() => invokeAPI('showModal', { title: 'Confirm', fail })).not.toThrow()

		const params = bridge.invoke.mock.calls[0][0].body.params
		const error = { errMsg: 'showModal:fail cancel' }
		expect(() => callback.invoke(params.fail, error)).not.toThrow()
		expect(fail).toHaveBeenCalledWith(error)
	})

	it('does not pair success/fail for keep:true event registrations', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()

		invokeAPI('ExampleModule_onChange', {
			evtId: 'ExampleModule_onChange',
			keep: true,
			success,
		})

		const params = bridge.invoke.mock.calls[0][0].body.params
		const payload = { data: 1 }
		callback.invoke(params.success, payload)
		callback.invoke(params.success, payload)

		expect(success).toHaveBeenCalledTimes(2)
	})
})

describe('invokeAPI success/fail 空字符串视为未提供', () => {
	it('success 为空字符串时，success 侧仍要被登记为真实可用的配对回调 id，触发它会让 fail 失效', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const fail = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success: '', fail })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.success).toEqual(expect.any(String))
		expect(params.success).not.toBe('')

		callback.invoke(params.success, { errMsg: 'showModal:ok' })

		callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })
		expect(fail).not.toHaveBeenCalled()
	})

	it('fail 为空字符串时，fail 侧仍要被登记为真实可用的配对回调 id，触发它会让 success 失效', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success, fail: '' })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.fail).toEqual(expect.any(String))
		expect(params.fail).not.toBe('')

		callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })

		callback.invoke(params.success, { errMsg: 'showModal:ok' })
		expect(success).not.toHaveBeenCalled()
	})
})

describe('invokeAPI 只传一侧时，缺的一侧也要下发真实可用的配对回调', () => {
	it('只传 fail 时，下发的 success 是一个真实可用的 id，触发它不会抛异常，并且会让 fail 失效', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const fail = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', fail })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.success).toEqual(expect.any(String))
		expect(params.success).not.toBe('')

		expect(() => callback.invoke(params.success, { errMsg: 'showModal:ok' })).not.toThrow()

		callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })
		expect(fail).not.toHaveBeenCalled()
	})

	it('只传 success 时，下发的 fail 是一个真实可用的 id，触发它不会抛异常，并且会让 success 失效', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()

		invokeAPI('showModal', { title: 'Confirm', success })

		const params = bridge.invoke.mock.calls[0][0].body.params
		expect(params.fail).toEqual(expect.any(String))
		expect(params.fail).not.toBe('')

		expect(() => callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })).not.toThrow()

		callback.invoke(params.success, { errMsg: 'showModal:ok' })
		expect(success).not.toHaveBeenCalled()
	})
})

describe('invokeAPI 桥同步抛错时，本次登记的回调 id 必须被清理干净', () => {
	it('success + fail + complete 都传了，桥抛错后异常照常往外抛，但三个 id 全部已被摘掉', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => invokeAPI('showModal', { title: 'Confirm', success, fail, complete })).toThrow('bridge down')

		const params = bridge.invoke.mock.calls[0][0].body.params

		callback.invoke(params.success, { errMsg: 'showModal:ok' })
		callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })
		callback.invoke(params.complete, { errMsg: 'showModal:ok' })

		expect(success).not.toHaveBeenCalled()
		expect(fail).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})

	it('只传 success（fail 由实现自动补一个），桥抛错后自动补的 fail id 和 success id 都已被摘掉', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const success = vi.fn()
		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})

		expect(() => invokeAPI('showModal', { title: 'Confirm', success })).toThrow('bridge down')

		const params = bridge.invoke.mock.calls[0][0].body.params

		callback.invoke(params.success, { errMsg: 'showModal:ok' })
		callback.invoke(params.fail, { errMsg: 'showModal:fail cancel' })

		expect(success).not.toHaveBeenCalled()
	})

	it('抛错之后再正常调用一次同一个接口，不受上一次残留影响，success 能正常触发', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const failedSuccess = vi.fn()
		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => invokeAPI('showModal', { title: 'Confirm', success: failedSuccess })).toThrow('bridge down')

		const success = vi.fn()
		invokeAPI('showModal', { title: 'Confirm', success })

		const params = bridge.invoke.mock.calls[1][0].body.params
		const result = { errMsg: 'showModal:ok' }
		callback.invoke(params.success, result)

		expect(success).toHaveBeenCalledWith(result)
		expect(failedSuccess).not.toHaveBeenCalled()
	})
})

describe('invokeAPI 桥同步抛错时，调用方指定的 evtId 不能被误删', () => {
	it('带 evtId 的调用抛错后，这个 evtId 依然能派发到某个回调，不会被当成本次新建的一次性回调摘掉', async () => {
		const { bridge, callback, invokeAPI } = await loadCommonApi()
		const listenerA = vi.fn()
		const listenerB = vi.fn()

		invokeAPI('mod_evt', { evtId: 'mod_evt', keep: true, success: listenerA })

		bridge.invoke.mockImplementationOnce(() => {
			throw new Error('bridge down')
		})
		expect(() => invokeAPI('mod_evt', { evtId: 'mod_evt', success: listenerB })).toThrow('bridge down')

		callback.invoke('mod_evt', { errMsg: 'mod_evt' })

		// 不断言覆盖到底是 A 还是 B——覆盖语义不是这条测试的目标，只断言这个 evtId
		// 没有被那次失败的调用从表里删掉，仍然能派发到某个监听。
		const totalCalls = listenerA.mock.calls.length + listenerB.mock.calls.length
		expect(totalCalls).toBeGreaterThan(0)
	})
})
