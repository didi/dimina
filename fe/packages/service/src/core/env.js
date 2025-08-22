import { modDefine, modRequire } from '@dimina/common'
import globalApi from '../api'
import { ComponentModule } from '../instance/component/component-module'
import { PageModule } from '../instance/page/page-module'
import loader from './loader'
import router from './router'

class Env {
	constructor() {
		this.init()
	}

	init() {
		globalThis.dd = globalThis.wx = globalApi
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
		globalThis.getApp = () =>
			loader.getAppModule()?.moduleInfo

		/**
		 * 获取当前页面栈。数组中第一个元素为首页，最后一个元素为当前页面
		 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/getCurrentPages.html
		 */
		globalThis.getCurrentPages = () =>
			router.stack()
	}
}

export default new Env()
