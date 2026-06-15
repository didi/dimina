import { modDefine, modRequire } from '@dimina/common'
import globalApi, { registerEnumerableApiNames } from '../api'
import { ComponentModule } from '../instance/component/component-module'
import { PageModule } from '../instance/page/page-module'
import loader from './loader'
import router from './router'
import runtime from './runtime'

class Env {
	constructor() {
		this.init()
	}

	init() {
		// Register API namespaces (dd, wx are built-in; custom ones from config)
		let customNamespaces = globalThis.__diminaApiNamespaces || []
		// 容器/原生侧已注册的 API 名字列表，供 globalApi Proxy 枚举使用（详见 ../api）
		let registeredApis = globalThis.__diminaRegisteredApis || []
		if (globalThis.name) {
			try {
				const config = JSON.parse(globalThis.name)
				if (customNamespaces.length === 0) {
					customNamespaces = config.apiNamespaces || []
				}
				if (registeredApis.length === 0) {
					registeredApis = config.registeredApis || []
				}
			} catch (e) {}
		}
		registerEnumerableApiNames(registeredApis)
		for (const name of ['dd', 'wx', ...customNamespaces]) {
			globalThis[name] = globalApi
		}
		globalThis.modRequire = modRequire
		globalThis.modDefine = modDefine
		globalThis.global = {}

		/**
		 * https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/app.html
		 */
		globalThis.App = moduleInfo =>
			loader.createAppModule(moduleInfo)

		globalThis.Page = (moduleInfo) => {
			loader.createModule(moduleInfo, globalThis.__extraInfo, PageModule.type)
		}

		globalThis.Component = (moduleInfo) => {
			loader.createModule(moduleInfo, globalThis.__extraInfo, ComponentModule.type)
		}

		/**
		 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/Behavior.html
		 */
		globalThis.Behavior = (behaviorInfo) => {
			return behaviorInfo
		}

		/**
		 * 获取到小程序全局唯一的 App 实例
		 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/getApp.html
		 */
		globalThis.getApp = (options) => {
			const app = runtime.app
			if (!app && options?.allowDefault) {
				return {}
			}
			return app
		}

		/**
		 * 获取当前页面栈。数组中第一个元素为首页，最后一个元素为当前页面
		 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/getCurrentPages.html
		 */
		globalThis.getCurrentPages = () =>
			router.stack()
	}
}

export default new Env()
