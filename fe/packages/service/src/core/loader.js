import { isWebWorker, modRequire } from '@dimina/common'
import { AppModule } from '../instance/app/app-module'
import { ComponentModule } from '../instance/component/component-module'
import { PageModule } from '../instance/page/page-module'
import message from './message'
import router from './router'

class Loader {
	constructor() {
		this.staticModules = {}
	}

	/**
	 * [Container] loadResource -> [Service] loadResource
	 * @param {*} opts
	 */
	loadResource(opts) {
		const { appId, bridgeId, pagePath, root, baseUrl } = opts
		// webworker 需要主动加载资源
		if (isWebWorker) {
			this.isScriptLoaded = this.isScriptLoaded || {}
			if (!this.isScriptLoaded[root]) {
				const logicResourcePath = `${baseUrl}${appId}/${root}/logic.js`
				globalThis.importScripts(logicResourcePath)
				this.isScriptLoaded[root] = true
			}
		}
		// 防止 App 声明周期调用的 API 找不到对应的 Bridge
		router.setInitId(bridgeId)
		modRequire('app')
		modRequire(pagePath)

		message.invoke({
			type: 'serviceResourceLoaded',
			target: 'service',
			body: {
				bridgeId,
			},
		})
	}

	/**
	 * 创建逻辑层 App 映射实例
	 * @param {*} moduleInfo
	 */
	createAppModule(moduleInfo) {
		const appModule = new AppModule(moduleInfo)
		this.staticModules[AppModule.type] = appModule
	}

	/**
	 *创建逻辑层 Page/Component 映射实例
	 * [Container]loadResource -> [Service]loadResource -> globalThis.Page/globalThis.Component -> create
	 * @param {*} moduleInfo {{data: object, method: object}} 模块逻辑信息
	 * @param {*} extraInfo {{path: string, component: boolean, usingComponents: object}} 模块额外信息
	 * @param {*} type {{type: string}} type
	 */
	createModule(moduleInfo, extraInfo, type) {
		const { path, usingComponents } = extraInfo
		if (this.staticModules[path]) {
			return
		}

		if (usingComponents) {
			for (const componentPath of Object.values(usingComponents)) {
				modRequire(componentPath)
			}
		}

		if (type === PageModule.type) {
			const pageModule = new PageModule(moduleInfo, extraInfo)
			this.staticModules[path] = pageModule
		}
		else if (type === ComponentModule.type) {
			const componentModule = new ComponentModule(moduleInfo, extraInfo)
			this.staticModules[path] = componentModule
		}
		else {
			console.error(`[service] createModule ${type} error`)
		}
	}

	getPropsByPath(usingComponents) {
		const res = {}
		this.getComponentProps(res, usingComponents)
		return res
	}

	getComponentProps(res, usingComponents) {
		if (!usingComponents) {
			return
		}

		for (const componentPath of Object.values(usingComponents)) {
			const component = this.staticModules[componentPath]
			if (!component || res[componentPath]) {
				continue
			}
			res[componentPath] = component.getProps()
			this.getComponentProps(res, component.usingComponents)
		}
	}

	getAppModule() {
		return this.staticModules[AppModule.type]
	}

	getModuleByPath(path) {
		return this.staticModules[path]
	}
}

export default new Loader()
