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
			statusBarHeight: 20,
			windowWidth: 375,
			windowHeight: 667,
			screenWidth: 375,
			screenHeight: 667,
			pixelRatio: 2,
		}

		hostEnv.init({ systemInfo })

		expect(getWindowInfo()).toBe(systemInfo)
		expect(getSystemInfoSync()).toBe(systemInfo)
		expect(getAppBaseInfo()).toBe(systemInfo)
		expect(getDeviceInfo()).toBe(systemInfo)
	})
})
