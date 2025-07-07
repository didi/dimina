import { isFunction } from '@dimina/common'
import { App } from '../instance/app/app'
import { Component } from '../instance/component/component'
import { ComponentModule } from '../instance/component/component-module'
import { Page } from '../instance/page/page'
import { PageModule } from '../instance/page/page-module'
import loader from './loader'
import router from './router'

class Runtime {
	constructor() {
		this.app = null
		this.instances = {}
	}

	createApp(opts) {
		// app 实例只有一个，避免重复创建
		if (this.app) {
			console.log('[service] app instance already existed')
			return
		}

		const { scene, pagePath: path, query } = opts
		const appModule = loader.getAppModule()

		if (!appModule) {
			console.log('[service] app instance is not exist')
			return
		}

		console.log('[service] create app instance')

		this.app = new App(appModule, {
			scene,
			path,
			query,
		})
	}

	appShow() {
		this.app?.appShow()
	}

	appHide() {
		this.app?.appHide()
	}

	stackShow(stackId) {
		router.pushStack(stackId)
	}

	stackHide(stackId) {
		router.popStack(stackId)
	}

	/**
	 * 渲染层创建映射实例
	 * [Render]componentCreated -> [Container]createInstance ->[Service]createInstance
	 * @param {*} opts
	 */
	createInstance(opts) {
		const { bridgeId, moduleId, path, query, eventAttr, pageId, parentId, properties, targetInfo, stackId } = opts

		const module = loader.getModuleByPath(path)
		if (!module) {
			console.error(`[service] ${path} not exist`)
			return
		}

		console.log(`[service] create instance ${path}`)

		this.instances[bridgeId] = this.instances[bridgeId] || {}

		if (module.type === ComponentModule.type) {
			const component = new Component(module, {
				bridgeId,
				moduleId,
				path,
				query,
				eventAttr,
				pageId,
				parentId,
				properties,
				targetInfo,
			})
			this.instances[bridgeId][moduleId] = component
			if (!module.isComponent) {
				router.push(component, stackId)
			}
			component.init()
			return component
		}
		else if (module.type === PageModule.type) {
			const page = new Page(module, {
				bridgeId,
				moduleId,
				path,
				query,
			})
			this.instances[bridgeId][moduleId] = page
			router.push(page, stackId)
			page.init()
			return page
		}
		else {
			console.error(`[service] ${module.type} instance is not exist.`)
		}
	}

	moduleAttached(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentAttached()
		}
	}

	moduleReady(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentReadied()
		}
	}

	moduleUnmounted(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentDetached()
		}
		delete this.instances[bridgeId][moduleId]
	}

	pageShow(opts) {
		const { bridgeId } = opts
		const instances = this.instances[bridgeId]

		// 首次进入时模块可能不存在
		if (!instances) {
			return
		}

		const pageInstances = []

		Object.values(instances).forEach((instance) => {
			if (!instance) {
				return
			}
			if (instance.__type__ === PageModule.type) {
				pageInstances.push(instance)
			}
			else if (instance.__type__ === ComponentModule.type) {
				if (!instance.__isComponent__) {
					pageInstances.push(instance)
				}
				else {
					instance.pageShow()
				}
			}
		})

		// 在循环结束后，统一调用页面的 pageShow 方法
		pageInstances.forEach((instance) => {
			instance.pageShow()
		})
	}

	pageReady(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		this.pageShow(opts)
		instance.pageReady()
	}

	pageHide(opts) {
		const { bridgeId } = opts
		const instances = this.instances[bridgeId]

		const pageInstances = []

		Object.values(instances).forEach((instance) => {
			if (!instance) {
				return
			}
			if (instance.__type__ === PageModule.type) {
				pageInstances.push(instance)
			}
			else if (instance.__type__ === ComponentModule.type) {
				if (!instance.__isComponent__) {
					pageInstances.push(instance)
				}
				else {
					instance.pageHide()
				}
			}
		})

		// 在循环结束后，统一调用页面的 pageHide 方法
		pageInstances.forEach((instance) => {
			if (!instance) {
				return
			}
			instance.pageHide()
		})
	}

	pageUnload(opts) {
		const { bridgeId } = opts
		const instances = this.instances[bridgeId]

		if (!instances) {
			return
		}

		Object.values(instances).forEach((instance) => {
			if (!instance) {
				return
			}
			if (instance.__type__ === ComponentModule.type) {
				instance.componentDetached()
			}
			instance.pageUnload()
		})

		router.pop()

		delete this.instances[bridgeId]
	}

	pageScroll(opts) {
		const { bridgeId, moduleId, scrollTop } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}
		instance.pageScrollTop({ scrollTop })
	}

	pageResize(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		instance.pageResize()
	}

	componentError(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentError()
		}
	}

	componentRouteDone(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId][moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentRouteDone()
		}
	}

	/**
	 * 调用业务 js 方法
	 * @param {*} opts
	 */
	async triggerEvent(opts) {
		const { bridgeId, moduleId, methodName, event } = opts

		if (methodName === undefined) {
			return
		}

		const instances = this.instances[bridgeId]
		if (!instances) {
			console.warn(`[service] No instances found for bridgeId: ${bridgeId}`)
			return
		}

		const instance = instances[moduleId]
		if (!instance) {
			console.warn(`[service] triggerEvent ${bridgeId} ${moduleId} ${methodName}, instance is not exist`)
			return
		}

		if (isFunction(instance[methodName])) {
			return await instance[methodName](event)
		}
		else {
			console.warn(`[service] triggerEvent ${bridgeId} ${moduleId}, is: ${instance.is}, method: ${methodName} is not exist`)
		}
	}
}

export default new Runtime()
