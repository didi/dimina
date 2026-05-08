import { isFunction } from '@dimina/common'

const lifecycleMethods = ['onLaunch', 'onShow', 'onHide']
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
		this.onLaunch?.(this.options)
		this.onShow?.(this.options)
	}

	appShow() {
		this.onShow?.(this.options)
	}

	appHide() {
		this.onHide?.()
	}
}
