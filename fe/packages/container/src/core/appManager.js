import { MiniApp } from '@/pages/miniApp/miniApp'
import { queryPath } from '@/utils/util'

export class AppManager {
	static appStack = []
	static apiRegistry = {}
	static _extModules = {}

	static registerApi(name, handler) {
		this.apiRegistry[name] = handler
	}

	/**
	 * 注册第三方扩展 bridge 模块
	 * @param {string} moduleName - 模块名称，对应 extBridge/extOnBridge 的 module 参数
	 * @param {Function} handler - 处理函数，签名：({ event, data, success, fail }) => unsubscribeFn | void
	 */
	static registerExtModule(moduleName, handler) {
		this._extModules[moduleName] = handler
	}

	/**
	 * 获取已注册的第三方扩展模块处理器
	 * @param {string} moduleName
	 * @returns {Function|undefined} 指定模块的处理函数，若未注册则返回 undefined
	 */
	static getExtModule(moduleName) {
		return this._extModules[moduleName]
	}

	/**
	 * 获取所有已注册的第三方扩展模块
	 * @returns {Record<string, Function>} 以模块名为键、处理函数为值的对象
	 */
	static getExtModules() {
		return this._extModules
	}

	static async openApp(opts, dimina) {
		const { appId, path, scene, destroy, name, logo, restoreStack } = opts
		const { pagePath, query } = queryPath(path)

		if (destroy) { // 打开新小程序前销毁之前的小程序视图
			for (const app of this.appStack) {
				if (app.appId !== appId) {
					const currentBridge = app.bridgeList.pop()
					currentBridge?.destroy()
					dimina.destroyRootView(app)
				}
			}
		}

		const cacheApp = this.getAppById(appId)

		if (cacheApp) {
			dimina.presentView(cacheApp, true)
		}
		else {
			const miniApp = new MiniApp({
				appId,
				scene,
				name,
				logo,
				pagePath,
				query,
				apiRegistry: this.apiRegistry,
				restoreStack, // 完整页面栈，用于刷新后静默恢复
			})

			this.appStack.push(miniApp)
			dimina.presentView(miniApp, false)
		}
	}

	static getAppById(appId) {
		for (const app of this.appStack) {
			if (app.appId === appId) {
				return app
			}
		}
		return null
	}

	static popView() {
		this.appStack.pop()
	}

	static closeApp(miniApp) {
		miniApp.parent.dismissView({
			destroy: false, // 关闭时是否销毁小程序容器
		})
	}
}
