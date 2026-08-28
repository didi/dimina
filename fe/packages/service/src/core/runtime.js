import { isFunction } from '@dimina/common'
import { emitAppHide, emitAppShow, reportAppError } from './app-events'
import { invokeSafely } from './safe-callback'
import { App } from '../instance/app/app'
import { Component } from '../instance/component/component'
import { ComponentModule } from '../instance/component/component-module'
import { Page } from '../instance/page/page'
import { PageModule } from '../instance/page/page-module'
import loader from './loader'
import router from './router'

class Runtime {
	constructor() {
		this.app = undefined
		this.defaultApp = {}
		this.appLaunchOptions = {}
		this.appEnterOptions = {}
		this.instances = {}
		this.pageStates = new Map()
		this.runtimeType = 'miniProgram'
		this.gameLaunched = false
	}

	setRuntimeType(runtimeType) {
		this.runtimeType = runtimeType === 'game' ? 'game' : 'miniProgram'
	}

	isMiniGame() {
		return this.runtimeType === 'game'
	}

	setAppLaunchOptions(options) {
		if (!this.app) {
			this.appLaunchOptions = this.normalizeAppOptions(options)
			this.appEnterOptions = this.appLaunchOptions
		}
	}

	normalizeAppOptions(options = {}) {
		const { pagePath, path = pagePath, ...rest } = options || {}
		const normalized = {
			...rest,
			path,
		}
		for (const key of Object.keys(normalized)) {
			if (normalized[key] === undefined) {
				delete normalized[key]
			}
		}
		return normalized
	}

	getAppLaunchOptions() {
		return this.appLaunchOptions
	}

	getAppEnterOptions() {
		return this.appEnterOptions
	}

	getApp(options = {}) {
		return options.allowDefault ? this.app || this.defaultApp : this.app
	}

	getPageState(bridgeId) {
		if (!this.pageStates.has(bridgeId)) {
			this.pageStates.set(bridgeId, {
				hidden: false,
				pendingReady: false,
				pendingShow: false,
				ready: false,
				shown: false,
			})
		}
		return this.pageStates.get(bridgeId)
	}

	queuePendingEvent(instance, payload) {
		instance.__pendingRuntimeEvents__ = instance.__pendingRuntimeEvents__ || []
		return new Promise((resolve, reject) => {
			instance.__pendingRuntimeEvents__.push({
				...payload,
				resolve,
				reject,
			})
		})
	}

	async flushPendingEvents(instance) {
		const pendingEvents = instance?.__pendingRuntimeEvents__ || []
		instance.__pendingRuntimeEvents__ = []

		for (const pendingEvent of pendingEvents) {
			try {
				const result = await this.dispatchEvent(pendingEvent)
				pendingEvent.resolve(result)
			}
			catch (error) {
				pendingEvent.reject(error)
			}
		}
	}

	async dispatchEvent({ instance, bridgeId, moduleId, methodName, event }) {
		if (isFunction(instance[methodName])) {
			const result = invokeSafely(instance, instance[methodName], [event], `event ${methodName}`)
			try {
				return await result
			}
			catch (error) {
				if (isFunction(instance.componentError)) {
					instance.componentError(error)
				}
				reportAppError(error)
				console.error(`[service] event ${methodName} error:`, error)
				return undefined
			}
		}
		console.warn(`[service] triggerEvent ${bridgeId} ${moduleId}, is: ${instance.is}, method: ${methodName} is not exist`)
	}

	createApp(opts = this.appLaunchOptions) {
		// app 实例只有一个，避免重复创建
		if (this.app) {
			console.log('[service] app instance already existed')
			return
		}

		const appOptions = this.normalizeAppOptions(opts)
		const appModule = loader.getAppModule()

		if (!appModule) {
			console.log('[service] app instance is not exist')
			return
		}

		console.log('[service] create app instance')

		// 与微信基础库一致：allowDefault 返回的占位对象会在 App 声明时
		// 覆盖合并到 App 配置中，随后为下一次声明重置占位对象。
		Object.assign(appModule.moduleInfo, this.defaultApp)
		this.defaultApp = {}
		this.appLaunchOptions = appOptions
		this.appEnterOptions = appOptions
		this.app = new App(appModule, appOptions)
	}

	appShow(options) {
		if (options && Object.keys(options).length > 0) {
			this.appEnterOptions = this.normalizeAppOptions(options)
		}
		if (this.app) {
			this.app.appShow(this.appEnterOptions)
		}
		else if (this.isMiniGame() && this.gameLaunched) {
			emitAppShow(this.appEnterOptions)
		}
	}

	appHide() {
		if (this.app) {
			this.app.appHide()
		}
		else if (this.isMiniGame() && this.gameLaunched) {
			emitAppHide()
		}
	}

	gameLaunch() {
		if (!this.isMiniGame() || this.gameLaunched) {
			return
		}
		this.gameLaunched = true
		emitAppShow(this.appEnterOptions)
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
		const { bridgeId, moduleId, path, query, eventAttr, pageId, parentId, properties, propertyNames, targetInfo, stackId, isCustomTabBar = false, deferInitialData = false, deferPageLoad = false } = opts

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
				isCustomTabBar,
				query,
				eventAttr,
				pageId,
				parentId,
				properties,
				propertyNames,
				targetInfo,
			})
			this.instances[bridgeId][moduleId] = component
			if (!module.isComponent) {
				router.push(component, stackId)
			}
			component.init({ deferInitialData, deferPageLoad })
			const state = this.getPageState(bridgeId)
			if (!module.isComponent && state.pendingShow && !state.hidden) {
				this.pageShow({ bridgeId, moduleId })
			}
			
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
			page.init({ deferInitialData, deferPageLoad })
			const state = this.getPageState(bridgeId)
			if (state.pendingShow && !state.hidden) {
				this.pageShow({ bridgeId, moduleId })
			}
			return page
		}
		else {
			console.error(`[service] ${module.type} instance is not exist.`)
		}
	}

	moduleAttached(opts) {
		const { bridgeId, moduleId, parentId } = opts
		const instance = this.instances[bridgeId]?.[moduleId]
		if (!instance || instance.__type__ !== ComponentModule.type || !instance.__isComponent__) {
			return
		}
		if (instance.__componentAttached__ || instance.__componentAttaching__) {
			return
		}
		if (parentId && this.instances[bridgeId]?.[parentId]) {
			instance.__parentId__ = parentId
		}

		const parent = this.instances[bridgeId]?.[instance.__parentId__]
		if (parent?.__isComponent__ && !parent.__componentAttached__) {
			instance.__componentAttachPending__ = true
			return
		}
		instance.__componentAttachPending__ = false
		instance.__componentAttaching__ = true
		try {
			// exparser 在调用 attached 前先把实例标记为已进入节点树。
			instance.__componentAttached__ = true
			instance.componentAttached()

			instance.__componentAttaching__ = false
			const state = this.getPageState(bridgeId)
			if (state.shown && !instance.__pageShown__) {
				instance.__pageShown__ = true
				if (!state.ready) {
					// The first visibility signal can cross the render thread's initial
					// attachment messages. Preserve that initial show, but do not
					// synthesize show for components inserted after page onReady.
					instance.pageShow()
				}
			}

			const children = Object.values(this.instances[bridgeId] || {}).filter(child => (
				child?.__parentId__ === moduleId && child.__componentAttachPending__
			))
			for (const child of children) {
				this.moduleAttached({ bridgeId, moduleId: child.__id__ })
			}

			if (instance.__pendingReadyOpts__) {
				const pendingReadyOpts = instance.__pendingReadyOpts__
				delete instance.__pendingReadyOpts__
				this.moduleReady(pendingReadyOpts)
			}
		}
		finally {
			instance.__componentAttaching__ = false
		}
	}

	moduleReady(opts) {
		const { bridgeId, moduleId, propBindings, eventPath } = opts
		const instance = this.instances[bridgeId]?.[moduleId]

		if (!instance) {
			return
		}

		if (Array.isArray(eventPath)) {
			instance.__eventPath__ = eventPath
		}
		
		// 如果有属性绑定信息，注册到父组件
		if (propBindings && instance.__parentId__) {
			const parent = this.instances[bridgeId]?.[instance.__parentId__]
			if (parent) {
				if (!parent.__childPropsBindings__) {
					parent.__childPropsBindings__ = {}
				}
				// 将编译器提供的绑定关系存储到父组件
				parent.__childPropsBindings__[moduleId] = propBindings
			}
		}

		if (instance.__type__ === ComponentModule.type) {
			if (instance.__isComponent__ && !instance.__componentAttached__) {
				instance.__pendingReadyOpts__ = opts
				return
			}
			if (instance.__componentReadied__) {
				return
			}
			const pageInstance = this.getPageInstance(bridgeId)
			if (instance.__isComponent__ && pageInstance?.__pageLoadPending__) {
				instance.__pendingReadyOpts__ = opts
				return
			}
			const pendingChildren = Object.values(this.instances[bridgeId] || {}).some(child => (
				child?.__isComponent__
				&& child.__componentAttached__
				&& !child.__componentReadied__
				&& this.isDescendantInstance(child, instance, bridgeId)
			))
			if (pendingChildren) {
				instance.__pendingReadyOpts__ = opts
				return
			}
			// Mark ready before invoking user code so re-entrant messages cannot
			// dispatch the lifetime twice.
			instance.__componentReadied__ = true
			instance.componentReadied()
			this.flushPendingEvents(instance)
			instance.flushInitSetDataCallbacks?.()
			
			// 检查是否可以调用页面的 onReady
			if (pageInstance) {
				this.checkAndCallPageReady(bridgeId, pageInstance.__id__)
			}

			let parent = this.instances[bridgeId]?.[instance.__parentId__]
			while (parent?.__isComponent__) {
				if (parent.__pendingReadyOpts__) {
					const pendingReadyOpts = parent.__pendingReadyOpts__
					delete parent.__pendingReadyOpts__
					this.moduleReady(pendingReadyOpts)
				}
				parent = this.instances[bridgeId]?.[parent.__parentId__]
			}
		}
	}

	pageAttached(opts) {
		const { bridgeId } = opts
		const pageInstance = this.getPageInstance(bridgeId)
		if (!pageInstance?.__pageLoadPending__) {
			return
		}

		pageInstance.pageAttached()
		const state = this.getPageState(bridgeId)
		if (state.pendingShow && !state.hidden) {
			this.pageShow({ bridgeId, moduleId: pageInstance.__id__ })
		}

		// mR can arrive before the page-root mounted acknowledgement. Release
		// those ready callbacks only after onLoad/onShow, child before parent.
		this.getInstancesInTreeOrder(bridgeId, { postOrder: true })
			.filter(instance => instance?.__isComponent__ && instance.__pendingReadyOpts__)
			.forEach((instance) => {
				const pendingReadyOpts = instance.__pendingReadyOpts__
				delete instance.__pendingReadyOpts__
				this.moduleReady(pendingReadyOpts)
			})
	}

	isDescendantInstance(candidate, ancestor, bridgeId) {
		let current = candidate
		while (current?.__parentId__) {
			if (current.__parentId__ === ancestor.__id__) {
				return true
			}
			current = this.instances[bridgeId]?.[current.__parentId__]
		}
		return false
	}

	moduleUnmounted(opts) {
		const { bridgeId, moduleId } = opts
		const instance = this.instances[bridgeId]?.[moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			if ((!instance.__isComponent__ || instance.__componentAttached__) && !instance.__componentDetached__) {
				instance.__componentDetached__ = true
				instance.componentDetached()
			}
		}
		delete this.instances[bridgeId][moduleId]
	}

	pageShow(opts) {
		const { bridgeId } = opts
		const state = this.getPageState(bridgeId)
		state.hidden = false
		state.pendingShow = true
		const instances = this.instances[bridgeId]

		// 首次进入时模块可能不存在
		if (!instances) {
			return
		}
		const pageInstance = this.getPageInstance(bridgeId)
		if (!pageInstance?.initd) {
			return
		}
		if (state.shown) {
			state.pendingShow = false
			return
		}
		state.shown = true
		state.pendingShow = false

		const pageInstances = []

		const orderedInstances = this.getInstancesInTreeOrder(bridgeId)

		orderedInstances.forEach((instance) => {
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
				else if (instance.__componentAttached__ && !instance.__pageShown__) {
					instance.__pageShown__ = true
					instance.pageShow()
				}
			}
		})

		// 在循环结束后，统一调用页面的 pageShow 方法
		pageInstances.forEach((instance) => {
			instance.pageShow()
		})

		if (state.pendingReady) {
			this.pageReady({ ...opts, moduleId: pageInstance.__id__ })
		}
	}

	pageReady(opts) {
		const { bridgeId, moduleId } = opts
		const state = this.getPageState(bridgeId)
		state.pendingReady = true
		const instance = this.instances[bridgeId]?.[moduleId]

		if (!instance) {
			return
		}

		if (state.hidden || !state.shown || state.ready) {
			return
		}
		
		// 标记页面准备就绪，但延迟调用 onReady
		// 等待所有组件的 ready 执行完毕后再调用
		instance.__pageReadyPending__ = true
		instance.flushInitSetDataCallbacks?.()
		
		// 检查是否所有组件都已经准备就绪
		this.checkAndCallPageReady(bridgeId, moduleId)
	}

	/**
	 * 检查并调用页面的 onReady
	 * 确保所有组件的 ready 都已执行完毕
	 */
	/**
	 * 获取指定 bridgeId 下的页面实例
	 */
	getPageInstance(bridgeId) {
		const instances = this.instances[bridgeId]
		if (!instances) {
			return null
		}

		return Object.values(instances).find(instance => {
			return instance && (
				instance.__type__ === PageModule.type || 
				(instance.__type__ === ComponentModule.type && !instance.__isComponent__)
			)
		})
	}

	checkAndCallPageReady(bridgeId, moduleId) {
		const state = this.getPageState(bridgeId)
		const instance = this.instances[bridgeId]?.[moduleId]
		if (!instance || !instance.__pageReadyPending__ || !state.shown || state.ready) {
			return
		}

		const instances = this.instances[bridgeId]
		if (!instances) {
			// 没有组件，直接调用页面 onReady
			instance.__pageReadyPending__ = false
			state.pendingReady = false
			state.ready = true
			instance.pageReady()
			return
		}

		// 检查是否还有组件未准备就绪
		const pendingComponents = Object.values(instances).filter(componentInstance => {
			return componentInstance && 
				componentInstance.__type__ === ComponentModule.type && 
				componentInstance.__isComponent__ &&
				componentInstance.initd &&
				!componentInstance.__componentReadied__
		})

		if (pendingComponents.length === 0) {
			// 所有组件都已准备就绪，调用页面 onReady
			instance.__pageReadyPending__ = false
			state.pendingReady = false
			state.ready = true
			instance.pageReady()
		}
	}

	pageHide(opts) {
		const { bridgeId } = opts
		const state = this.getPageState(bridgeId)
		state.hidden = true
		state.pendingShow = false
		if (!state.shown) {
			return
		}
		state.shown = false
		const instances = this.instances[bridgeId]
		if (!instances) {
			return
		}

		const pageInstances = []

		const orderedInstances = this.getInstancesInTreeOrder(bridgeId)

		orderedInstances.forEach((instance) => {
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
				else if (instance.__componentAttached__ && instance.__pageShown__) {
					instance.__pageShown__ = false
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
		const state = this.getPageState(bridgeId)
		if (state.unloading) {
			return
		}
		state.unloading = true

		const pageInstance = this.getPageInstance(bridgeId)
		// WeChat dispatches the page's onUnload before tearing down its component
		// subtree. The page root itself detaches after every descendant.
		pageInstance?.pageUnload()

		const customComponents = this.getInstancesInTreeOrder(bridgeId, { postOrder: true })
			.filter(instance => instance?.__type__ === ComponentModule.type && instance.__isComponent__)

		customComponents.forEach((instance) => {
			if (instance.__componentAttached__ && !instance.__componentDetached__) {
				instance.__componentDetached__ = true
				instance.componentDetached()
			}
		})

		if (pageInstance?.__type__ === ComponentModule.type && !pageInstance.__componentDetached__) {
			pageInstance.__componentDetached__ = true
			pageInstance.componentDetached()
		}
		else if (pageInstance?.__type__ === PageModule.type) {
			pageInstance.pageDetached?.()
		}

		router.remove(bridgeId)

		delete this.instances[bridgeId]
		this.pageStates.delete(bridgeId)
	}

	getInstancesInTreeOrder(bridgeId, { postOrder = false } = {}) {
		const instances = Object.values(this.instances[bridgeId] || {}).filter(Boolean)
		const byId = new Map(instances.map(instance => [instance.__id__, instance]))
		const childrenByParentId = new Map()
		const roots = []

		for (const instance of instances) {
			if (instance.__parentId__ && byId.has(instance.__parentId__)) {
				const children = childrenByParentId.get(instance.__parentId__) || []
				children.push(instance)
				childrenByParentId.set(instance.__parentId__, children)
			}
			else {
				roots.push(instance)
			}
		}

		const ordered = []
		const visited = new Set()
		const visit = (instance) => {
			if (!instance || visited.has(instance)) {
				return
			}
			visited.add(instance)
			if (!postOrder) {
				ordered.push(instance)
			}
			for (const child of childrenByParentId.get(instance.__id__) || []) {
				visit(child)
			}
			if (postOrder) {
				ordered.push(instance)
			}
		}

		roots.forEach(visit)
		// Keep malformed/orphaned cycles observable and deterministic instead of
		// silently dropping them from lifecycle delivery.
		instances.forEach(visit)
		return ordered
	}

	pageScroll(opts) {
		const { bridgeId, moduleId, scrollTop } = opts
		const instance = this.instances[bridgeId]?.[moduleId]

		if (!instance) {
			return
		}
		instance.pageScrollTop({ scrollTop })
	}

	pagePullDownRefresh({ bridgeId }) {
		this.getPageInstance(bridgeId)?.pagePullDownRefresh()
	}

	pageReachBottom({ bridgeId }) {
		this.getPageInstance(bridgeId)?.pageReachBottom()
	}

	pageShareAppMessage({ bridgeId, ...options }) {
		return this.getPageInstance(bridgeId)?.pageShareAppMessage(options)
	}

	pageTabItemTap({ bridgeId, ...item }) {
		this.getPageInstance(bridgeId)?.pageTabItemTap(item)
	}

	pageResize(opts) {
		const { bridgeId, size } = opts
		const instances = this.instances[bridgeId]

		if (!instances) {
			return
		}

		const pageInstances = []
		const orderedInstances = this.getInstancesInTreeOrder(bridgeId)

		orderedInstances.forEach((instance) => {
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
				else if (instance.__componentAttached__) {
					instance.pageResize(size)
				}
			}
		})

		pageInstances.forEach(instance => instance.pageResize(size))
	}

	componentError(opts) {
		const { bridgeId, moduleId, error } = opts
		const instance = this.instances[bridgeId]?.[moduleId]

		if (!instance) {
			return
		}

		if (instance.__type__ === ComponentModule.type) {
			instance.componentError(error)
		}
		reportAppError(error)
	}

	componentRouteDone(opts) {
		const { bridgeId } = opts
		const instances = this.instances[bridgeId]

		if (!instances) {
			return
		}

		this.getInstancesInTreeOrder(bridgeId)
			.forEach((instance) => {
				if (instance?.__type__ === ComponentModule.type && (!instance.__isComponent__ || instance.__componentAttached__)) {
					instance.componentRouteDone()
				}
			})
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

		if (
			instance.__type__ === ComponentModule.type
			&& instance.__isComponent__
			&& !instance.__componentReadied__
		) {
			return this.queuePendingEvent(instance, {
				instance,
				bridgeId,
				moduleId,
				methodName,
				event,
			})
		}

		return this.dispatchEvent({
			instance,
			bridgeId,
			moduleId,
			methodName,
			event,
		})
	}
}

export default new Runtime()
