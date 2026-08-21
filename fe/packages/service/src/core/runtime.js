import { callback, isFunction } from '@dimina/common'
import { emitAppHide, emitAppShow, reportAppError } from './app-events'
import { invokeSafely } from './safe-callback'
import { App } from '../instance/app/app'
import { Component } from '../instance/component/component'
import { ComponentModule } from '../instance/component/component-module'
import { Page } from '../instance/page/page'
import { PageModule } from '../instance/page/page-module'
import loader from './loader'
import router from './router'
import hostEnv from './host-env'
import { windowResizeListenerIds } from './window-resize-listeners'

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
		// One geometry baseline for the whole mini-app, plus the accumulators the 16ms merge window fills before it fires.
		this.resizeGate = {
			baseline: { windowWidth: 0, windowHeight: 0, deviceOrientation: '' },
			timer: null,
			fireWindow: false,
			pendingPageOwners: [],
			lastEvent: null,
		}
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
				visibilityGeneration: 0,
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
		const { bridgeId, moduleId, path, query, eventAttr, pageId, parentId, properties, propertyNames, targetInfo, stackId, isCustomTabBar = false, deferInitialData = false } = opts

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
			component.init({ deferInitialData })
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
			page.init({ deferInitialData })
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
			if (this.getPageState(bridgeId).shown && !instance.__pageShown__) {
				instance.__pageShown__ = true
				instance.pageShow()
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
			const pageInstance = this.getPageInstance(bridgeId)
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
				instance.componentDetached()
				instance.__componentDetached__ = true
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
		state.visibilityGeneration += 1

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
		state.visibilityGeneration += 1
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

		const instanceList = this.getInstancesInTreeOrder(bridgeId)
		const customComponents = this.getInstancesInTreeOrder(bridgeId, { postOrder: true })
			.filter(instance => instance?.__type__ === ComponentModule.type && instance.__isComponent__)

		customComponents.forEach((instance) => {
			if (instance.__componentAttached__ && !instance.__componentDetached__) {
				instance.componentDetached()
				instance.__componentDetached__ = true
			}
		})

		instanceList.forEach((instance) => {
			if (!instance) {
				return
			}
			if (instance.__type__ === ComponentModule.type && !instance.__isComponent__ && !instance.__componentDetached__) {
				instance.componentDetached()
				instance.__componentDetached__ = true
			}
			instance.pageUnload()
		})

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

	/**
	 * 一次尺寸变化的判据，两条通道各自独立：
	 * - 窗口通道（wx.onWindowResize）：这次上报的宽、高、方向相对应用级基线是否变化。
	 * - 页面通道（Page.onResize）：只要这次上报点到了某一页就派发给它，与几何是否变化无关。
	 * 何时上报由宿主决定，路由落地时宿主每次都上报落点页。
	 * 页面配置的方向不是 auto 时两条通道一起被抑制。
	 * 基线在抑制判断之前更新，被抑制的变化仍然成为下一次比较的基准。
	 *
	 * 宿主上报 pageOrientation 即表示把判据交给这里，自己只上报原始事实；不上报则表示宿主已在本地判完（模拟器走这条），这里直接放行页面通道、不触发窗口通道——模拟器的 wx.onWindowResize 监听表在主进程，这里再触发一遍会重复回调，也不动应用级基线。
	 */
	resolveResizeDispatch(size, deviceOrientation, pageOrientation) {
		if (!pageOrientation) {
			return { fireWindow: false, dispatchPage: true }
		}

		const gate = this.resizeGate
		const baseline = gate.baseline
		const changed = deviceOrientation !== baseline.deviceOrientation
			|| size.windowWidth !== baseline.windowWidth
			|| size.windowHeight !== baseline.windowHeight

		baseline.deviceOrientation = deviceOrientation
		baseline.windowWidth = size.windowWidth
		baseline.windowHeight = size.windowHeight

		const suppressed = pageOrientation.originalPageOrientation !== 'auto'

		return {
			fireWindow: changed && !suppressed,
			dispatchPage: !suppressed,
		}
	}

	/**
	 * 把这次上报的窗口事实写回 hostEnv 快照。
	 *
	 * 只对「在 loadResource 里下发过 hostEnv 快照」的宿主有意义——目前是 HarmonyOS （DMPContainer.loadResourceService）、web 容器和 kit 模拟器，它们的 `wx.getWindowInfo` / `wx.getSystemInfoSync` 读的就是这份快照。
	 * Android 与 iOS 不下发，那两端的 `getWindowInfo` 是同步桥调用、每次读活的窗口，`hostEnv.getSystemInfo()` 返回 null，这里首行即返回，不需要也没有这份缓存。
	 *
	 * 存在的理由：固定方向页的两条 resize 通道都被抑制，落地后如果不刷新这份快照，它读到的会一直是上一页的几何且再没有纠正机会。
	 * 缓存的窗口事实与两条通道是彼此独立的两件事。
	 */
	updateWindowFacts(size, deviceOrientation) {
		const systemInfo = hostEnv.getSystemInfo()
		if (!systemInfo) {
			return
		}
		// 屏幕尺寸只在宿主这次带了才写：它跟窗口尺寸一起随旋转交换宽高，不刷新的话 getSystemInfoSync().screenWidth 会一直停在旋转前的值。
		// 没带的宿主保持原样——用 undefined 覆盖掉一个本来正确的值比留着旧值更糟。
		const screen = {}
		if (size.screenWidth !== undefined) {
			screen.screenWidth = size.screenWidth
		}
		if (size.screenHeight !== undefined) {
			screen.screenHeight = size.screenHeight
		}
		hostEnv.update({
			systemInfo: {
				...systemInfo,
				...screen,
				windowWidth: size.windowWidth,
				windowHeight: size.windowHeight,
				deviceOrientation,
			},
		})
	}

	/**
	 * 派发给单个 bridgeId 挂载的页面/组件实例。
	 * 调用方已经用页面可见 generation 确认这次尺寸事实仍属于当前显示周期；bridgeId 在结算前已经 pageUnload 时静默跳过。
	 */
	dispatchPageResize(bridgeId, res) {
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
					instance.pageResize(res)
				}
			}
		})

		pageInstances.forEach(instance => instance.pageResize(res))
	}

	/**
	 * 结算 16ms 合并窗口：窗口通道按窗口内是否有任意一次上报想触发做或运算，并使用窗口内最后一次上报的几何。
	 * 页面通道只派发给登记后始终处于同一显示周期的页面；hide/unload 或 hide→show 会推进 generation，让旧页面报告不能在结算时复活。
	 */
	settleResize() {
		const gate = this.resizeGate
		gate.timer = null
		const fireWindow = gate.fireWindow
		const pageOwners = gate.pendingPageOwners
		const res = gate.lastEvent
		gate.fireWindow = false
		gate.pendingPageOwners = []
		gate.lastEvent = null

		if (!res) {
			return
		}

		if (fireWindow) {
			windowResizeListenerIds().forEach(evtId => callback.invoke(evtId, res))
		}

		pageOwners.forEach(({ bridgeId, visibilityGeneration }) => {
			const state = this.pageStates.get(bridgeId)
			if (!state?.shown || state.hidden) {
				return
			}
			// visibilityGeneration 为 null 表示登记时这一页还没 show：那是路由落地页自己的那一次上报（宿主先送几何、再送 pageShow），此刻它已经 show 出来，就该收到。
			if (visibilityGeneration !== null && state.visibilityGeneration !== visibilityGeneration) {
				return
			}
			this.dispatchPageResize(bridgeId, res)
		})
	}

	pageResize(opts) {
		const { bridgeId, size, deviceOrientation, pageOrientation } = opts

		// 这里不按 bridgeId 拦截还没注册实例的上报：应用级基线必须无条件推进，否则宿主早于页面实例创建发来的那次几何变化会永久缺席基线，之后一次真实的几何变化会被误判成"没变过"。
		// 实例是否存在在结算阶段由 dispatchPageResize 自己判，取不到就静默跳过。
		// res 对齐微信 Page.onResize / behavior pageLifetimes.resize 的入参形状：{ size, deviceOrientation }。
		// size 原样透传宿主给的那个对象，字段由宿主决定：文档只保证 windowWidth/windowHeight，四端还会带上整块屏幕的 screenWidth/screenHeight。
		// deviceOrientation 缺失时按屏幕宽高比兜底，与微信官方文档建议一致。
		const res = {
			size,
			deviceOrientation: deviceOrientation ?? (size.windowWidth > size.windowHeight ? 'landscape' : 'portrait'),
		}

		// 缓存的窗口事实与两条通道无关：无论这次上报是否派发回调，都要刷新 wx.getWindowInfo / getSystemInfoSync 读到的窗口尺寸，固定方向页那次被抑制的上报也不例外。
		// 不刷新的话，固定方向页落地后读到的会一直是上一页的几何，而它的两条 resize 通道都被抑制，再也没有纠正它的机会。
		this.updateWindowFacts(size, res.deviceOrientation)

		const { fireWindow, dispatchPage } = this.resolveResizeDispatch(size, res.deviceOrientation, pageOrientation)

		const gate = this.resizeGate
		gate.lastEvent = res
		if (fireWindow) {
			gate.fireWindow = true
		}
		if (dispatchPage) {
			const pageState = this.pageStates.get(bridgeId)
			// 收件人在结算时才定，登记时不要求这一页已经 show：模拟器宿主为了让 onShow 同步读到落地页自己的尺寸，会先送几何、再送 pageShow，两条都在同一个 16ms 合并窗内（见 packages/dimina-electron-runtime 的 miniapp-frame applySideEffects）。
			// 登记时已经 show 的，这份几何就绑在那一次显示周期上，中途 hide 过即作废；登记时还没 show 的记 null，等结算时它 show 出来再派发，没 show 出来就丢弃。
			const visibilityGeneration = pageState?.shown && !pageState.hidden
				? pageState.visibilityGeneration
				: null
			const pending = gate.pendingPageOwners.find(entry => entry.bridgeId === bridgeId)
			if (pending) {
				// 同一合并窗口内 hide→show 后的新报告接管所有权；没有新报告时旧 generation 会在 settleResize 被丢弃，不能把旧页面尺寸派发到新的显示周期。
				pending.visibilityGeneration = visibilityGeneration
			}
			else {
				gate.pendingPageOwners.push({ bridgeId, visibilityGeneration })
			}
		}

		if (!gate.timer) {
			gate.timer = setTimeout(() => this.settleResize(), 16)
		}
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
