import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import {
	offUserCaptureScreen,
	onUserCaptureScreen,
} from '../src/api/core/device/screen/index.js'

describe('screen capture event api', () => {
	beforeEach(() => {
		offUserCaptureScreen()
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('keeps capture screen listeners alive', () => {
		const listener = vi.fn()
		onUserCaptureScreen(listener)
		const params = vi.mocked(invokeAPI).mock.calls[0][1]

		callback.invoke(params.callbackId, {})
		callback.invoke(params.callbackId, {})

		expect(invokeAPI).toHaveBeenCalledWith('onUserCaptureScreen', {
			callbackId: params.callbackId,
			success: params.callbackId,
			keep: true,
		})
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it('replaces the old listener when a new listener is registered', () => {
		const first = vi.fn()
		const second = vi.fn()
		onUserCaptureScreen(first)
		onUserCaptureScreen(second)
		const firstCallbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId
		const secondCallbackId = vi.mocked(invokeAPI).mock.calls[2][1].callbackId

		expect(vi.mocked(invokeAPI).mock.calls[1]).toEqual([
			'offUserCaptureScreen',
			{ callbackId: firstCallbackId, keep: true },
		])

		callback.invoke(firstCallbackId, {})
		callback.invoke(secondCallbackId, {})

		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
	})

	it('does not remove the current listener when a different listener is supplied', () => {
		const current = vi.fn()
		const other = vi.fn()
		onUserCaptureScreen(current)
		const callbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId

		offUserCaptureScreen(other)

		expect(invokeAPI).toHaveBeenCalledTimes(1)
		callback.invoke(callbackId, {})
		expect(current).toHaveBeenCalledTimes(1)
		expect(other).not.toHaveBeenCalled()
	})

	it('removes the current capture screen listener when no function is supplied', () => {
		const listener = vi.fn()
		onUserCaptureScreen(listener)
		const callbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId

		offUserCaptureScreen()

		expect(invokeAPI).toHaveBeenLastCalledWith('offUserCaptureScreen')
		callback.invoke(callbackId, {})
		expect(listener).not.toHaveBeenCalled()
	})
})
