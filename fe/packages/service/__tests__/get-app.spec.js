import { modDefine } from '@dimina/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import loader from '../src/core/loader'
import runtime from '../src/core/runtime'
import '../src/index'

describe('getApp', () => {
	beforeEach(() => {
		runtime.app = undefined
		runtime.defaultApp = {}
		runtime.appLaunchOptions = {}
		runtime.appEnterOptions = {}
		runtime.instances = {}
		runtime.pageStates.clear()
		delete loader.staticModules.app
		globalThis.DiminaServiceBridge.invoke = vi.fn()
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	it('keeps and merges the allowDefault app before App is declared', () => {
		expect(globalThis.getApp()).toBeUndefined()

		const defaultApp = globalThis.getApp({ allowDefault: true })
		expect(globalThis.getApp({ allowDefault: true })).toBe(defaultApp)

		defaultApp.defaultOnly = 'from-default-app'
		defaultApp.conflict = 'default-app-wins'
		defaultApp.defaultMethod = function () {
			return this
		}

		const query = { source: 'test' }
		let appSeenInOnLaunch
		let launchOptions
		runtime.setAppLaunchOptions({
			scene: 1001,
			pagePath: 'pages/index/index',
			query,
		})
		globalThis.App({
			globalData: { ready: true },
			appOnly: 'from-app',
			conflict: 'app-value',
			onLaunch(options) {
				appSeenInOnLaunch = globalThis.getApp()
				launchOptions = options
			},
		})

		const app = globalThis.getApp()
		expect(app).not.toBe(defaultApp)
		expect(globalThis.getApp({ allowDefault: true })).toBe(app)
		expect(app.defaultOnly).toBe('from-default-app')
		expect(app.appOnly).toBe('from-app')
		expect(app.conflict).toBe('default-app-wins')
		expect(app.defaultMethod()).toBe(app)
		// 与微信一致：App 生命周期函数内应使用 this，正式实例会在构造完成后发布给 getApp。
		expect(appSeenInOnLaunch).toBeUndefined()
		expect(launchOptions).toEqual({
			scene: 1001,
			path: 'pages/index/index',
			query,
		})
	})

	it('supports allowDefault from a module outside Page when an independent package has no app module', () => {
		const helperPath = 'independent/utils/app-context'
		const pagePath = 'independent/pages/index/index'
		let appSeenByHelper
		let appSeenByPage

		modDefine(helperPath, (require, module) => {
			appSeenByHelper = globalThis.getApp({ allowDefault: true })
			appSeenByHelper.fromIndependentModule = 'ready'
			module.exports = () => globalThis.getApp({ allowDefault: true })
		})
		modDefine(pagePath, (require) => {
			appSeenByPage = require(helperPath)()
			globalThis.__extraInfo = {
				path: pagePath,
				usingComponents: {},
			}
			globalThis.Page({})
		})

		globalThis.DiminaServiceBridge.onMessage({
			type: 'loadResource',
			body: {
				appId: 'get-app-independent-test',
				bridgeId: 'bridge-get-app-independent',
				pagePath,
				query: {},
				resourceLoadId: 'resource-get-app-independent',
				root: 'independent',
				scene: 1001,
			},
		})

		expect(globalThis.getApp()).toBeUndefined()
		expect(appSeenByHelper).toBe(appSeenByPage)
		expect(appSeenByPage.fromIndependentModule).toBe('ready')
		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledWith(expect.objectContaining({
			type: 'serviceResourceLoaded',
			body: expect.objectContaining({
				resourceLoadId: 'resource-get-app-independent',
			}),
		}))

		globalThis.App({
			globalData: { ready: true },
		})
		const app = globalThis.getApp()
		expect(app).not.toBe(appSeenByHelper)
		expect(app.fromIndependentModule).toBe('ready')
		expect(globalThis.getApp({ allowDefault: true })).toBe(app)

		delete loader.staticModules[pagePath]
	})

	it('creates the App before evaluating ordinary modules outside the first Page declaration', () => {
		const bootstrapHelperPath = 'utils/get-app-before-declaration'
		const helperPath = 'utils/get-app-startup'
		const pagePath = 'pages/get-app-startup/index'
		const query = { id: 'startup' }
		let appSeenWithoutDefaultBeforeDeclaration
		let defaultAppSeenByBootstrapHelper
		let appSeenByHelper
		let appSeenByPage
		let launchOptions

		modDefine(bootstrapHelperPath, () => {
			appSeenWithoutDefaultBeforeDeclaration = globalThis.getApp()
			defaultAppSeenByBootstrapHelper = globalThis.getApp({ allowDefault: true })
			defaultAppSeenByBootstrapHelper.fromBootstrapHelper = 'ready'
		})
		modDefine('app', (require) => {
			require(bootstrapHelperPath)
			globalThis.App({
				globalData: { ready: true },
				onLaunch(options) {
					launchOptions = options
				},
			})
		})
		modDefine(helperPath, (require, module) => {
			appSeenByHelper = globalThis.getApp()
			module.exports = appSeenByHelper
		})
		modDefine(pagePath, (require) => {
			require(helperPath)
			appSeenByPage = globalThis.getApp()
			globalThis.__extraInfo = {
				path: pagePath,
				usingComponents: {},
			}
			globalThis.Page({})
		})

		globalThis.DiminaServiceBridge.onMessage({
			type: 'loadResource',
			body: {
				appId: 'get-app-test',
				bridgeId: 'bridge-get-app',
				pagePath,
				query,
				resourceLoadId: 'resource-get-app',
				root: '.',
				scene: 1001,
			},
		})

		expect(appSeenWithoutDefaultBeforeDeclaration).toBeUndefined()
		expect(defaultAppSeenByBootstrapHelper).not.toBe(globalThis.getApp())
		expect(appSeenByPage).toBe(globalThis.getApp())
		expect(appSeenByHelper).toBe(globalThis.getApp())
		expect(appSeenByPage.fromBootstrapHelper).toBe('ready')
		expect(appSeenByPage.globalData).toEqual({ ready: true })
		expect(launchOptions).toEqual({
			scene: 1001,
			path: pagePath,
			query,
		})
		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledWith(expect.objectContaining({
			type: 'serviceResourceLoaded',
			body: expect.objectContaining({
				resourceLoadId: 'resource-get-app',
			}),
		}))

		delete loader.staticModules[pagePath]
	})
})
