import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnterOptionsSync, getLaunchOptionsSync } from '../src/api/core/life-cycle'
import runtime from '../src/core/runtime'

describe('mini program launch and enter options', () => {
	beforeEach(() => {
		runtime.app = undefined
		runtime.appLaunchOptions = {}
		runtime.appEnterOptions = {}
	})

	it('keeps launch options stable while a mini-program return updates enter options and App.onShow', () => {
		const launchOptions = {
			scene: 1037,
			pagePath: 'pages/index/index',
			query: { from: 'source' },
			referrerInfo: { appId: 'source-app', extraData: { token: 'open' } },
		}
		runtime.setAppLaunchOptions(launchOptions)

		const appShow = vi.fn()
		runtime.app = { appShow }
		const returnOptions = {
			scene: 1038,
			path: 'pages/index/index',
			query: { from: 'source' },
			referrerInfo: { appId: 'target-app', extraData: { token: 'back' } },
		}
		runtime.appShow(returnOptions)

		expect(getLaunchOptionsSync()).toEqual({
			scene: 1037,
			path: 'pages/index/index',
			query: { from: 'source' },
			referrerInfo: { appId: 'source-app', extraData: { token: 'open' } },
		})
		expect(getEnterOptionsSync()).toEqual(returnOptions)
		expect(appShow).toHaveBeenCalledWith(returnOptions)
	})

	it('does not expose undefined referrerInfo and reuses the latest enter options on a plain foreground event', () => {
		runtime.setAppLaunchOptions({
			scene: 1001,
			pagePath: 'pages/index/index',
			query: {},
			referrerInfo: undefined,
		})
		const appShow = vi.fn()
		runtime.app = { appShow }

		runtime.appShow()

		expect(getLaunchOptionsSync()).toEqual({
			scene: 1001,
			path: 'pages/index/index',
			query: {},
		})
		expect(getEnterOptionsSync()).toEqual(getLaunchOptionsSync())
		expect(appShow).toHaveBeenCalledWith(getLaunchOptionsSync())
	})
})
