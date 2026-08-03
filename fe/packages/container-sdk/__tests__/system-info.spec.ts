import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

describe('MiniApp system info', () => {
	it('handles getSystemInfo as a built-in API instead of an extension subscription', () => {
		const app = Object.create(MiniApp.prototype) as MiniApp
		app.apiRegistry = {}
		app.jscore = { postMessage: vi.fn() } as unknown as MiniApp['jscore']
		app.getSystemInfoSync = vi.fn(() => ({
			platform: 'devtools',
			windowWidth: 375,
		})) as unknown as MiniApp['getSystemInfoSync']
		app._handleExtCall = vi.fn()

		app.invokeApi('getSystemInfo', {
			success: 'success-id',
			complete: 'complete-id',
		})

		expect(app._handleExtCall).not.toHaveBeenCalled()
		expect(app.jscore.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'triggerCallback',
			body: {
				id: 'success-id',
				args: {
					platform: 'devtools',
					windowWidth: 375,
					errMsg: 'getSystemInfo:ok',
				},
			},
		})
		expect(app.jscore.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'triggerCallback',
			body: {
				id: 'complete-id',
			},
		})
	})

	it('fails unsupported callback APIs without routing them to extOnBridge', () => {
		const app = Object.create(MiniApp.prototype) as MiniApp
		app.apiRegistry = {}
		app.jscore = { postMessage: vi.fn() } as unknown as MiniApp['jscore']
		app._handleExtCall = vi.fn()

		app.invokeApi('getLocation', {
			fail: 'fail-id',
			complete: 'complete-id',
		})

		expect(app._handleExtCall).not.toHaveBeenCalled()
		expect(app.jscore.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'triggerCallback',
			body: {
				id: 'fail-id',
				args: { errMsg: 'getLocation:fail api is not supported' },
			},
		})
		expect(app.jscore.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'triggerCallback',
			body: {
				id: 'complete-id',
			},
		})
	})
})
