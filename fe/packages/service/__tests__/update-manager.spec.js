import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = new Map()
const invokeAPI = vi.fn()

async function loadUpdateModule() {
	vi.resetModules()
	listeners.clear()
	invokeAPI.mockReset()

	vi.doMock('@/core/message', () => ({
		default: {
			on: vi.fn((type, cb) => {
				listeners.set(type, cb)
			}),
		},
	}))

	vi.doMock('@/api/common', () => ({
		invokeAPI,
	}))

	return import('../src/api/core/base/update/index.js')
}

function emitUpdateStatus(body) {
	listeners.get('onUpdateStatusChange')?.(body)
}

describe('UpdateManager API', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('returns a global singleton update manager', async () => {
		const { getUpdateManager } = await loadUpdateModule()

		expect(getUpdateManager()).toBe(getUpdateManager())
	})

	it('marks update manager schemas as available in canIUse', async () => {
		vi.resetModules()
		const { canIUse } = await import('../src/api/core/base/index.js')

		expect(canIUse('getUpdateManager')).toBe(true)
		expect(canIUse('UpdateManager')).toBe(true)
		expect(canIUse('UpdateManager.applyUpdate')).toBe(true)
		expect(canIUse('UpdateManager.onCheckForUpdate')).toBe(true)
		expect(canIUse('UpdateManager.onUpdateFailed')).toBe(true)
		expect(canIUse('UpdateManager.onUpdateReady')).toBe(true)
	})

	it('reports check result with the documented hasUpdate value', async () => {
		const { getUpdateManager } = await loadUpdateModule()
		const updateManager = getUpdateManager()
		const listener = vi.fn()

		updateManager.onCheckForUpdate(listener)
		emitUpdateStatus({ event: 'noupdate' })
		emitUpdateStatus({ event: 'updating' })

		expect(listener).toHaveBeenNthCalledWith(1, { hasUpdate: false })
		expect(listener).toHaveBeenNthCalledWith(2, { hasUpdate: true })
	})

	it('replays a check result that arrives before listener registration', async () => {
		const { getUpdateManager } = await loadUpdateModule()

		emitUpdateStatus({ event: 'noupdate' })

		const listener = vi.fn()
		getUpdateManager().onCheckForUpdate(listener)

		expect(listener).toHaveBeenCalledWith({ hasUpdate: false })
	})

	it('fires ready and failed listeners without payloads', async () => {
		const { getUpdateManager } = await loadUpdateModule()
		const updateManager = getUpdateManager()
		const readyListener = vi.fn()
		const failedListener = vi.fn()

		updateManager.onUpdateReady(readyListener)
		updateManager.onUpdateFailed(failedListener)

		emitUpdateStatus({ event: 'updateready', strategy: 'warm' })
		emitUpdateStatus({ event: 'updatefail' })

		expect(readyListener).toHaveBeenCalledWith()
		expect(failedListener).toHaveBeenCalledWith()
	})

	it('reports one positive check while update moves from downloading to ready', async () => {
		const { getUpdateManager } = await loadUpdateModule()
		const updateManager = getUpdateManager()
		const checkListener = vi.fn()
		const readyListener = vi.fn()

		updateManager.onCheckForUpdate(checkListener)
		updateManager.onUpdateReady(readyListener)

		emitUpdateStatus({ event: 'updating' })
		emitUpdateStatus({ event: 'updateready' })
		emitUpdateStatus({ event: 'updateready' })

		expect(checkListener).toHaveBeenCalledTimes(1)
		expect(checkListener).toHaveBeenCalledWith({ hasUpdate: true })
		expect(readyListener).toHaveBeenCalledTimes(1)
	})

	it('applies a ready update at most once', async () => {
		const { getUpdateManager } = await loadUpdateModule()
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const updateManager = getUpdateManager()

		updateManager.applyUpdate()
		expect(invokeAPI).not.toHaveBeenCalled()
		expect(error).toHaveBeenCalledWith('[applyUpdate]: update is not ready')

		emitUpdateStatus({ event: 'updateready' })
		updateManager.applyUpdate()
		updateManager.applyUpdate()

		expect(invokeAPI).toHaveBeenCalledTimes(1)
		expect(invokeAPI).toHaveBeenCalledWith('applyUpdate')
		expect(error).toHaveBeenCalledWith('[applyUpdate]: applyUpdate has been called')
	})
})
