import { afterEach, describe, expect, it } from 'vitest'
import hostEnv from '../src/core/host-env.js'
import {
	getAppBaseInfo,
	getDeviceInfo,
	getSystemInfoSync,
	getWindowInfo,
} from '../src/api/core/base/system/index.js'

describe('system info api', () => {
	afterEach(() => {
		hostEnv.reset()
	})

	it('should prefer host env sync info for system-related apis', () => {
		const systemInfo = {
			// window info fields
			statusBarHeight: 20,
			windowWidth: 375,
			windowHeight: 667,
			screenWidth: 375,
			screenHeight: 667,
			pixelRatio: 2,
			safeArea: { top: 20, bottom: 667, left: 0, right: 375, width: 375, height: 647 },
			// app base info fields
			SDKVersion: '3.0.0',
			enableDebug: false,
			host: { appId: 'test' },
			language: 'zh_CN',
			version: '1.0.0',
			theme: 'light',
			fontSizeScaleFactor: 1,
			fontSizeSetting: 16,
			// device info fields
			brand: 'test',
			model: 'test',
			platform: 'devtools',
			system: 'web',
		}

		hostEnv.init({ systemInfo })

		expect(getWindowInfo()).toEqual({
			pixelRatio: 2,
			screenWidth: 375,
			screenHeight: 667,
			windowWidth: 375,
			windowHeight: 667,
			statusBarHeight: 20,
			safeArea: { top: 20, bottom: 667, left: 0, right: 375, width: 375, height: 647 },
		})
		expect(getSystemInfoSync()).toBe(systemInfo)
		expect(getAppBaseInfo()).toEqual({
			SDKVersion: '3.0.0',
			enableDebug: false,
			host: { appId: 'test' },
			language: 'zh_CN',
			version: '1.0.0',
			theme: 'light',
			fontSizeScaleFactor: 1,
			fontSizeSetting: 16,
		})
		expect(getDeviceInfo()).toEqual({
			brand: 'test',
			model: 'test',
			platform: 'devtools',
			system: 'web',
		})
	})
})
