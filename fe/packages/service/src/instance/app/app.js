import { isFunction } from '@dimina/common'
import { emitAppHide, emitAppShow, setAppErrorHandler } from '../../core/app-events'
import { invokeSafely } from '../../core/safe-callback'

const lifecycleMethods = ['onLaunch', 'onShow', 'onHide', 'onError']
const reservedProperties = ['globalData']

export class App {
	constructor(appModule, options) {
		this.appModule = appModule
		this.options = options
		this.init()
	}

	init() {
		this.initGlobalData()
		this.initLifecycle()
		this.initCustomMethods()
		setAppErrorHandler(this.onError)
		this.invokeSomeLifecycle()
	}

	initGlobalData() {
		this.globalData = this.appModule.moduleInfo.globalData
	}

	initLifecycle() {
		// https://developers.weixin.qq.com/miniprogram/dev/reference/api/App.html
		lifecycleMethods.forEach((method) => {
			const lifecycleMethod = this.appModule.moduleInfo[method]
			if (!isFunction(lifecycleMethod)) {
				return
			}
			this[method] = lifecycleMethod.bind(this)
		})
	}

	initCustomMethods() {
		const moduleInfo = this.appModule.moduleInfo
		for (const attr in moduleInfo) {
			if (lifecycleMethods.includes(attr) || reservedProperties.includes(attr)) {
				continue
			}

			if (isFunction(moduleInfo[attr])) {
				this[attr] = moduleInfo[attr].bind(this)
			}
			else {
				this[attr] = moduleInfo[attr]
			}
		}
	}

	invokeSomeLifecycle() {
		invokeSafely(this, this.onLaunch, [this.options], 'onLaunch')
		invokeSafely(this, this.onShow, [this.options], 'onShow')
		emitAppShow(this.options)
	}

	appShow(options = this.options) {
		invokeSafely(this, this.onShow, [options], 'onShow')
		emitAppShow(options)
	}

	appHide() {
		invokeSafely(this, this.onHide, [], 'onHide')
		emitAppHide()
	}
}
