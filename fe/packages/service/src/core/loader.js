import { hasModule, isWebWorker, modRequire } from '@dimina/common'
import { disposeCanvasNodes, installMiniGameGlobals } from '../api/core/ui/canvas/canvas-node'
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
		const { appId, bridgeId, pagePath, root, baseUrl, resourceLoadId, runtimeType } = opts
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
		if (runtimeType === 'game') {
			disposeCanvasNodes(bridgeId)
			installMiniGameGlobals()
			modRequire(pagePath)
			message.invoke({
				type: 'serviceResourceLoaded',
				target: 'service',
				body: { bridgeId, resourceLoadId },
			})
			return true
		}
		// 独立分包不会打包主包 app 模块。与微信运行库一致，此时允许
		// 分包依赖通过 getApp({ allowDefault: true }) 使用默认 App；等主包
		// app 模块真正加载后，runtime 会把默认对象合并进正式 App 实例。
		if (hasModule('app')) {
			modRequire('app')
		}
		modRequire(pagePath)

		message.invoke({
			type: 'serviceResourceLoaded',
			target: 'service',
			body: {
				bridgeId,
				resourceLoadId,
			},
		})
		return true
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
