import { deepEqual, getDataAttributes, set, uuid } from '@dimina/common'
import { Components, deepToRaw, triggerEvent } from '@dimina/components'
import {
	createApp,
	createBlock,
	createCommentVNode,
	createElementBlock,
	createElementVNode,
	createSlots,
	createTextVNode,
	createVNode,
	Fragment,
	getCurrentInstance,
	h,
	inject,
	nextTick,
	normalizeClass,
	normalizeStyle,
	onMounted,
	onUnmounted,
	openBlock,
	provide,
	reactive,
	renderList,
	renderSlot,
	resolveComponent,
	resolveDirective,
	resolveDynamicComponent,
	Suspense,
	toDisplayString,
	watch,
	watchEffect,
	withCtx,
	withDirectives,
} from 'vue'
import loader from './loader'
import message from './message'

// Keep these aliases in sync with @vue/compiler-core helperNameMap/aliasHelper output.
const VUE_RUNTIME_HELPERS = {
	_Fragment: Fragment,
	_createTextVNode: createTextVNode,
	_createVNode: createVNode,
	_createBlock: createBlock,
	_createCommentVNode: createCommentVNode,
	_createElementBlock: createElementBlock,
	_createElementVNode: createElementVNode,
	_createSlots: createSlots,
	_normalizeClass: normalizeClass,
	_normalizeStyle: normalizeStyle,
	_openBlock: openBlock,
	_renderList: renderList,
	_renderSlot: renderSlot,
	_resolveComponent: resolveComponent,
	_resolveDirective: resolveDirective,
	_resolveDynamicComponent: resolveDynamicComponent,
	_toDisplayString: toDisplayString,
	_withCtx: withCtx,
	_withDirectives: withDirectives,
}

class Runtime {
	constructor() {
		this.app = null
		this.pageId = null
		this.instance = new Map()
		this.moduleIds = new WeakMap()
		this.setupData = new Map()
		this.initializedModules = new Set()
		this.preInitUpdates = new Map()
		this.intersectionObservers = new Map()
		this.moduleRenderReadyPromises = new Map()
		this.moduleRenderReadyResolvers = new Map()
		this.renderReadyModules = new Set()
		this.handleBeforeUnload = this.handleBeforeUnload.bind(this)

		this.installVueRuntimeHelpers()
		window.addEventListener('beforeunload', this.handleBeforeUnload)
	}

	installVueRuntimeHelpers(target = window) {
		Object.assign(target, VUE_RUNTIME_HELPERS)
	}

	handleBeforeUnload() {
		if (this.intersectionObservers.size > 0) {
			for (const observers of this.intersectionObservers.values()) {
				observers.forEach(observer => observer.disconnect())
			}
			this.intersectionObservers.clear()
		}
	}

	syncReactiveState(state, nextState = {}) {
		for (const key in state) {
			if (!(key in nextState)) {
				delete state[key]
			}
		}

		Object.assign(state, nextState)
	}

	/**
	 * 首次渲染
	 * [Container] resourceLoaded -> [Service] firstRender -> [Render] firstRender
	 * @param {*} opts
	 */
	firstRender(opts) {
		const { bridgeId, pagePath, pageId, query } = opts

		const options = this.makeOptions({
			path: pagePath,
			bridgeId,
			pageId,
			query,
		})

		if (this.app != null) {
			this.app.unmount()
		}
		this.app = createApp(options.app)
		// 全量加载基础组件，是否有必要可优化为按需加载组件
		this.app.use(Components)

		this.registerTplComponentsByPath(opts.pagePath, bridgeId)

		this.app.mount(document.body)
	}

	registerTplComponentsByPath(path, bridgeId, visited = new Set()) {
		if (visited.has(path)) {
			return
		}
		visited.add(path)

		const module = loader.getModuleByPath(path)
		if (!module?.moduleInfo) {
			return
		}

		const { id, tplComponents = {}, usingComponents = {} } = module.moduleInfo
		const components = this.createComponent(path, bridgeId, usingComponents)
		for (const [tplName, render] of Object.entries(tplComponents)) {
			this.app.component(`dd-${tplName}`, this.createTplComponent({
				id,
				components,
				render,
			}))
		}

		for (const componentPath of Object.values(usingComponents)) {
			this.registerTplComponentsByPath(componentPath, bridgeId, visited)
		}
	}

	createTplComponent({ id, components, render }) {
		return {
			__scopeId: `data-v-${id}`,
			components,
			props: {
				data: Object,
			},
			setup(props) {
				const state = reactive({})
				watchEffect(() => {
					const newData = props.data || {}
					for (const key in state) {
						if (!(key in newData)) delete state[key]
					}
					Object.assign(state, newData)
				})
				return state
			},
			render,
		}
	}

	// Component create -> Page create -> Page attached -> Component attached -> Component ready -> Page ready
	// Component attached -> Page onLoad -> Page onShow -> Component ready -> onReady
	makeOptions(opts) {
		const { path, bridgeId, pageId } = opts
		const pageModule = loader.getModuleByPath(path)
		const { id, usingComponents, tplComponents } = pageModule.moduleInfo
		this.pageId = pageId
		const components = this.createComponent(path, bridgeId, usingComponents)
		const self = this
		const rootCom = 'dd-page'
		const sId = `data-v-${id}`
		return {
			id,
			tplComponents,
			app: {
				render: () => {
					const _component_dd_page = resolveComponent(rootCom)
					return h(Suspense, {
						onResolve: () => {
							message.invoke({
								type: 'domReady',
								target: 'container',
								body: {
									bridgeId,
								},
							})
						},
					}, {
						default: () => h(_component_dd_page, { class: 'dd-page' }),
						// fallback: () => h('div', 'Loading...'),
					})
				},
				components: {
					[rootCom]: {
						__scopeId: sId,
						async setup(_props, { expose }) {
							expose()
							provide('bridgeId', bridgeId)
							provide('path', path)
							provide(path, {
								id: self.pageId,
							})
							provide('info', {
								id: self.pageId,
								sId,
							})

							const instance = getCurrentInstance().proxy
							instance.__page__ = true
							self.setModuleInstance(self.pageId, instance)

							let ticking = false
							const handleScroll = () => {
								if (!ticking) {
									window.requestAnimationFrame(() => {
										message.send({
											type: 'pageScroll',
											target: 'service',
											body: {
												bridgeId,
												moduleId: self.pageId,
												scrollTop: window.scrollY,
											},
										})
										ticking = false
									})
									ticking = true
								}
							}

							onMounted(() => {
								window.addEventListener('scroll', handleScroll, { passive: true })
								nextTick(() => {
									message.send({
										type: 'pageReady',
										target: 'service',
										body: {
											bridgeId,
											moduleId: self.pageId,
										},
									})
									self.markModuleRenderReady(self.pageId)
								})
							})

							onUnmounted(() => {
								window.removeEventListener('scroll', handleScroll)
							})

						const data = reactive({})
						self.setupData.set(self.pageId, data)
						const initData = await message.wait(self.pageId)
						self.applyInitialData(self.pageId, data, initData)
						return data
					},
					components,
					render: pageModule.moduleInfo.render,
					},
				},

			},
		}
	}

	getParentModuleId(vueInstance) {
		let parent = vueInstance?.parent
		while (parent) {
			const moduleId = this.moduleIds.get(parent.proxy)
			if (moduleId) {
				return moduleId
			}
			parent = parent.parent
		}
	}

	applyInitialData(moduleId, data, initData) {
		const entries = Object.entries(initData)
		for (let i = 0; i < entries.length; i++) {
			const [key, value] = entries[i]
			set(data, key, value)
		}

		const pendingUpdate = this.preInitUpdates.get(moduleId)
		if (pendingUpdate) {
			for (const [key, value] of Object.entries(pendingUpdate)) {
				set(data, key, value)
			}
			this.preInitUpdates.delete(moduleId)
		}

		this.initializedModules.add(moduleId)
		return pendingUpdate
	}

	refreshProxyAccess(moduleId, changedData) {
		const instance = this.instance.get(moduleId)
		const internal = instance?.$
		if (!internal) {
			return
		}

		const { accessCache, ctx } = internal
		for (const [key, value] of Object.entries(changedData)) {
			if (accessCache && Object.hasOwn(accessCache, key)) {
				delete accessCache[key]
			}
			if (ctx && !Object.hasOwn(ctx, key)) {
				ctx[key] = value
			}
		}

		internal.update?.()
	}

	setModuleInstance(moduleId, instance) {
		if (!instance) {
			return
		}
		this.instance.set(moduleId, instance)
		this.moduleIds.set(instance, moduleId)
	}

	deleteModuleInstance(moduleId) {
		const instance = this.instance.get(moduleId)
		if (instance) {
			this.moduleIds.delete(instance)
		}
		this.instance.delete(moduleId)
	}

	ensureModuleRenderReady(moduleId) {
		if (!moduleId || this.renderReadyModules.has(moduleId)) {
			return Promise.resolve()
		}

		if (!this.moduleRenderReadyPromises.has(moduleId)) {
			this.moduleRenderReadyPromises.set(moduleId, new Promise((resolve) => {
				this.moduleRenderReadyResolvers.set(moduleId, resolve)
			}))
		}

		return this.moduleRenderReadyPromises.get(moduleId)
	}

	markModuleRenderReady(moduleId) {
		if (!moduleId || this.renderReadyModules.has(moduleId)) {
			return
		}

		this.renderReadyModules.add(moduleId)
		const resolve = this.moduleRenderReadyResolvers.get(moduleId)
		if (resolve) {
			resolve()
		}
		this.moduleRenderReadyResolvers.delete(moduleId)
		this.moduleRenderReadyPromises.delete(moduleId)
	}

	createComponent(path, bridgeId, usingComponents, depthChain = []) {
		if (!usingComponents || Object.keys(usingComponents).length === 0) {
			return
		}

		const components = {}
		const self = this
		const newDepthChain = [...depthChain, path]

		for (const [componentName, componentPath] of Object.entries(usingComponents)) {
			// 循环依赖检测（A -> B -> A）
			if (newDepthChain.includes(componentPath)) {
				continue
			}

			const module = loader.getModuleByPath(componentPath)
			if (!module?.moduleInfo) {
				continue
			}

			const { id, usingComponents: subUsing } = module.moduleInfo
			const subComponents = this.createComponent(componentPath, bridgeId, subUsing, newDepthChain)
			const sId = `data-v-${id}`

			// setup -> beforeCreate -> beforeMount
			components[`dd-${componentName}`] = {
				__scopeId: sId,
				components: subComponents,
				props: module.props,
				async setup(props, { attrs, expose }) {
					const parentInfo = inject('info')

					expose({
						props,
						sId: parentInfo.sId,
					})
					const vueInstance = getCurrentInstance()
					const vueParentId = self.getParentModuleId(vueInstance)
					const parentId = vueParentId || parentInfo.id
					const pageInfo = inject(path)
					const pageId = pageInfo.id
					const moduleId = `${id}_${uuid()}`
					provide('info', {
						id: moduleId,
						sId,
					})
					provide('path', componentPath)
					provide(componentPath, {
						id: moduleId,
						pagePath: path, // 引入该组件的页面信息
						pageId,
					})

					const instance = vueInstance.proxy
					self.setModuleInstance(moduleId, instance)

					const externalClasses = []
					for (const [k, v] of Object.entries(module.props ?? {})) {
						if (v.cls) {
							// 自定义组件的外部样式类，通过 v-c-class 自定义指令处理
							externalClasses.push(k)
						}
					}
					provide('externalClasses', externalClasses)

				const eventAttr = {}
				for (const attrName in attrs) {
					if (attrName.startsWith('bind') || attrName.startsWith('catch')) {
						eventAttr[attrName.replace(/^(?:bind:|bind|catch:|catch)/, '')] = attrs[attrName]
					}
				}

				message.send({
					type: 'mC', // createInstance + componentAttached
					target: 'service',
					body: {
						bridgeId,
						moduleId,
						path: componentPath,
						pageId,
						parentId,
						eventAttr,
						targetInfo: {
							dataset: getDataAttributes(attrs, deepToRaw),
							id: attrs.id,
							class: attrs.class,
						},
						properties: deepToRaw(props),
						propBindings: null, // 初始化时为 null，稍后从 DOM 元素读取
					},
				})

					onMounted(() => {
						nextTick(() => {
							// 从 DOM 元素读取属性绑定信息
							const propBindings = instance.$el?._propBindings

							message.send({
								type: 'mR',
								target: 'service',
								body: {
									bridgeId,
									moduleId,
									propBindings, // 传递从指令中读取的绑定信息
								},
							})
							self.markModuleRenderReady(moduleId)
						})
						// 自定义组件上绑定了点击事件
						if (eventAttr.tap) {
							instance.$el.addEventListener('click', (event) => {
								triggerEvent('tap', {
									event,
									info: {
										attrs,
										bridgeId,
										moduleId: pageId,
									},
								})
							})
						}
					})

				onUnmounted(() => {
					message.send({
						type: 'mU',
						target: 'service',
						body: {
							bridgeId,
							moduleId,
						},
					})
					self.deleteModuleInstance(moduleId)
					self.setupData.delete(moduleId)
					self.initializedModules.delete(moduleId)
					self.preInitUpdates.delete(moduleId)
				})

			const data = reactive({})
			self.setupData.set(moduleId, data)
			let skipInitialPropsNotify = true
			
		watch(
				() => deepToRaw(props),
				(newProps, oldProps = {}) => {
					Object.assign(data, newProps)
					if (skipInitialPropsNotify) {
						skipInitialPropsNotify = false
						return
					}

					const changedProps = Object.entries(newProps).reduce((acc, [key, value]) => {
						if (!deepEqual(value, oldProps[key])) {
							acc[key] = value
						}
						return acc
					}, {})

					if (Object.keys(changedProps).length === 0) {
						return
					}

					message.send({
						type: 't',
						target: 'service',
						body: {
							bridgeId,
							moduleId,
							methodName: 'tO', // triggerObserver
							event: changedProps,
						},
					})
				},
				{
					immediate: true,
				}
			)
					
					const initData = await message.wait(moduleId)
					self.applyInitialData(moduleId, data, initData)
					return data
				},
				render: module.moduleInfo.render,
			}
		}
		return components
	}

	updateModule(opts) {
		const { moduleId, data } = opts
		const setupData = this.setupData.get(moduleId)

		if (setupData) {
			let hasNewReactiveKey = false
			const newKeys = {}

			if (!this.initializedModules.has(moduleId)) {
				const pendingUpdate = this.preInitUpdates.get(moduleId) || {}
				Object.assign(pendingUpdate, data)
				this.preInitUpdates.set(moduleId, pendingUpdate)
			}
			for (const key in data) {
				if (!Object.hasOwn(setupData, key)) {
					hasNewReactiveKey = true
					newKeys[key] = data[key]
				}
				set(setupData, key, data[key])
			}
			if (hasNewReactiveKey) {
				this.refreshProxyAccess(moduleId, newKeys)
			}
		}
		else {
			console.warn('[system]', '[render]', `module ${moduleId} is not exist.`)
		}
	}

	updateModules(opts) {
		const { bridgeId, updates = [], callbackIds = [] } = opts
		updates.forEach(update => this.updateModule(update))

		if (callbackIds.length > 0) {
			nextTick(() => {
				callbackIds.forEach((id) => {
					message.send({
						type: 'triggerCallback',
						target: 'service',
						body: {
							bridgeId,
							id,
						},
					})
				})
			})
		}
	}

	async waitForEl(instance, timeout = 500) {
		if (!instance) {
			return
		}
		if (instance.__page__) {
			return document.body
		}
		const el = instance.$el
		if (el) {
			return el
		}

		return new Promise((resolve) => {
			const observer = new MutationObserver((_, obs) => {
				const el = instance.$el
				if (el) {
					obs.disconnect() // 停止观察
					resolve(el)
				}
			})

			if (instance.$parent.$el?.nodeType === Node.COMMENT_NODE) {
				observer.observe(document.body, { childList: true, subtree: true })
			}
			else {
				observer.observe(instance.$parent.$el, { childList: true })
			}

			// 设置超时处理
			setTimeout(() => {
				observer.disconnect() // 超时后停止观察
				resolve()
			}, timeout)
		})
	}

	async waitForElement(parent, selector, method, timeout = 500) {
		if (!parent[method]) {
			console.warn('[system]', '[render]', `waitForElement method ${method} in ${parent.nodeType}`)
			return null
		}
		const elements = parent[method](selector)
		if (this.hasMatchedElements(elements)) {
			return elements
		}
		return new Promise((resolve) => {
			const observer = new MutationObserver((_, obs) => {
				const elements = parent[method](selector)
				if (this.hasMatchedElements(elements)) {
					obs.disconnect()
					resolve(elements)
				}
			})

			observer.observe(parent, { childList: true, subtree: true })

			setTimeout(() => {
				observer.disconnect()
				resolve()
			}, timeout)
		})
	}

	hasMatchedElements(elements) {
		if (!elements) {
			return false
		}
		if (elements instanceof NodeList || Array.isArray(elements)) {
			return elements.length > 0
		}
		return true
	}

	async selectorQuery(opts) {
		const { bridgeId, params: { tasks, success } } = opts

		const executeQuery = async () => {
			const results = await Promise.all(tasks.map(async (task) => {
				const { moduleId, selector, single, fields } = task
				const el = await this.waitForEl(this.instance.get(moduleId))
				if (!el) {
					console.warn('[system]', '[render]', `module ${moduleId} dom is not exist.`)
					return null
				}

				if (!el.querySelector) {
					console.warn('system', '[render]', `selectorQuery el node type is ${el.nodeType}`)
					return null
				}

				const selectors = selector.split(',').map(s => `${s.trim()}:not([data-dd-cloned] *)`).join(',')

				if (single) {
					// 排除任何带有 data-dd-cloned 属性的父元素的子元素
					const targetElement = el.querySelector(selectors)
					return targetElement ? await this.parseElement(targetElement, fields) : null
				}
				else {
					// 排除带有 data-dd-cloned 属性的元素
					const targetElements = el.querySelectorAll(selectors)
					const results = []
					for (const el of targetElements) {
						const result = await this.parseElement(el, fields)
						results.push(result)
					}
					return results
				}
			}))

			return results.filter(Boolean)
		}

		try {
			// 使用 requestAnimationFrame 确保在下一帧执行
			const res = await new Promise((resolve) => {
				requestAnimationFrame(async () => {
					resolve(await executeQuery())
				})
			})

			message.send({
				type: 'triggerCallback',
				target: 'service',
				body: {
					bridgeId,
					id: success,
					args: res,
				},
			})
		}
		catch (error) {
			console.error('[system]', '[render]', 'selectorQuery error:', error)
		}
	}

	/**
	 * 确保元素已准备好（有尺寸）
	 */
	ensureElementReady(element) {
		return new Promise((resolve) => {
			if (this.isElementReady(element)) {
				return resolve(element)
			}

			const observer = new ResizeObserver((entries) => {
				if (entries[0]?.contentRect?.height > 0 || entries[0]?.contentRect?.width > 0) {
					observer.disconnect()
					resolve(element)
				}
			})

			observer.observe(element)

			// 设置超时，防止无限等待
			setTimeout(() => {
				observer.disconnect()
				resolve(element)
			}, 500)
		})
	}

	/**
	 * 检查元素是否已准备好（有尺寸）
	 */
	isElementReady(element) {
		if (!element) {
			return false
		}
		const rect = element.getBoundingClientRect()
		return rect.height > 0 || rect.width > 0
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.fields.html
	 */
	async parseElement(targetElement, fields) {
		// 确保元素已准备好（有尺寸）
		await this.ensureElementReady(targetElement)

		const data = {}

		if (fields.id) {
			data.id = targetElement.id ?? ''
		}

		if (fields.dataset) {
			data.dataset = targetElement._ds
		}

		// 是否返回节点 mark
		if (fields.mark) {
			data.mark = targetElement.dataset?.mark ?? ''
		}

		if (fields.rect) {
			const { left, top, right, bottom, width, height } = this.getElementRect(targetElement)
			data.left = left
			data.top = top
			data.right = right
			data.bottom = bottom
			data.width = width
			data.height = height
		}

		if (fields.size) {
			if (fields.rect) {
				const { width, height } = this.getElementRect(targetElement)
				data.width = width
				data.height = height
			}
			else {
				data.width = targetElement.offsetWidth
				data.height = targetElement.offsetHeight
			}
		}

		if (fields.scrollOffset) {
			data.scrollHeight = targetElement.scrollHeight
			data.scrollLeft = targetElement.scrollLeft
			data.scrollTop = targetElement.scrollTop
			data.scrollWidth = targetElement.scrollWidth
		}

		// 指定属性名列表，返回节点对应属性名的当前属性值（只能获得组件文档中标注的常规属性值，id class style 和事件绑定的属性值不可获取）
		if (fields.properties && Array.isArray(fields.properties)) {
			const properties = {}
			fields.properties.forEach((prop) => {
				if (prop !== 'id' && prop !== 'class' && prop !== 'style' && !prop.startsWith('bind') && !prop.startsWith('on')) {
					properties[prop] = targetElement.getAttribute(prop) ?? ''
				}
			})
			data.properties = properties
		}

		// 指定样式名列表，返回节点对应样式名的当前值
		if (fields.computedStyle && Array.isArray(fields.computedStyle)) {
			const computedStyle = window.getComputedStyle(targetElement)
			const styles = {}
			fields.computedStyle.forEach((style) => {
				styles[style] = computedStyle.getPropertyValue(style) || ''
			})
			data.computedStyle = styles
		}

		// TODO: 支持获取 Canvas 和 ScrollViewContext
		// if (fields.node) {
		// }
		// TODO: 支持获取 VideoContext、CanvasContext、LivePlayerContext、EditorContext和 MapContext
		// if (fields.context) {
		// }

		return data
	}

	getElementRect(element) {
		return element.getBoundingClientRect()
	}

	triggerCallback(bridgeId, id, args = [], data) {
		if (!id) {
			return
		}
		const body = {
			bridgeId,
			id,
		}
		if (args !== undefined) {
			body.args = args
		}
		if (data !== undefined) {
			body.data = data
		}
		message.send({
			type: 'triggerCallback',
			target: 'service',
			body,
		})
	}

	triggerCanvasFailure(bridgeId, params, errMsg) {
		const result = { errMsg }
		this.triggerCallback(bridgeId, params.fail, [result], result)
		this.triggerCallback(bridgeId, params.complete, [result], result)
	}

	async getCanvasElement(canvasId, moduleId) {
		const selector = `canvas[canvas-id="${canvasId}"]`
		const scope = moduleId ? await this.waitForEl(this.instance.get(moduleId)) : document.body
		if (scope?.querySelector) {
			const scopedCanvas = await this.waitForElement(scope, selector, 'querySelector')
			if (scopedCanvas) {
				return scopedCanvas
			}
		}
		return document.querySelector(selector)
	}

	ensureCanvasResolution(canvas) {
		const rect = canvas.getBoundingClientRect()
		const width = Math.max(Math.round(rect.width), 1)
		const height = Math.max(Math.round(rect.height), 1)

		if (canvas.width !== width) {
			canvas.width = width
		}
		if (canvas.height !== height) {
			canvas.height = height
		}
	}

	loadCanvasImage(src) {
		return new Promise((resolve, reject) => {
			const image = new Image()
			image.crossOrigin = 'anonymous'
			image.onload = () => resolve(image)
			image.onerror = () => reject(new Error(`Failed to load image: ${src}`))
			image.src = src
		})
	}

	async replayCanvasActions(context, actions = []) {
		const state = {
			fontSize: 10,
		}

		const applyFont = () => {
			context.font = `${state.fontSize}px sans-serif`
		}
		applyFont()

		for (const action of actions) {
			const { type, args = [] } = action || {}
			switch (type) {
				case 'beginPath':
				case 'closePath':
				case 'moveTo':
				case 'lineTo':
				case 'rect':
				case 'arc':
				case 'quadraticCurveTo':
				case 'bezierCurveTo':
				case 'fill':
				case 'stroke':
				case 'clearRect':
				case 'save':
				case 'restore':
				case 'translate':
				case 'rotate':
				case 'scale':
					context[type](...args)
					break
				case 'fillText':
					context.fillText(args[0], args[1], args[2], args[3])
					break
				case 'drawImage': {
					const [src, ...drawArgs] = args
					const image = await this.loadCanvasImage(src)
					context.drawImage(image, ...drawArgs)
					break
				}
				case 'setFillStyle':
					context.fillStyle = args[0]
					break
				case 'setStrokeStyle':
					context.strokeStyle = args[0]
					break
				case 'setGlobalAlpha':
					context.globalAlpha = args[0]
					break
				case 'setLineCap':
					context.lineCap = args[0]
					break
				case 'setLineJoin':
					context.lineJoin = args[0]
					break
				case 'setLineWidth':
					context.lineWidth = args[0]
					break
				case 'setMiterLimit':
					context.miterLimit = args[0]
					break
				case 'setFontSize':
					state.fontSize = args[0]
					applyFont()
					break
				case 'setShadow':
					context.shadowOffsetX = args[0]
					context.shadowOffsetY = args[1]
					context.shadowBlur = args[2]
					context.shadowColor = args[3]
					break
				default:
					console.warn('[system]', '[render]', `Unsupported canvas action: ${type}`)
			}
		}
	}

	async drawCanvas({ bridgeId, params }) {
		const { canvasId, actions = [], reserve = false } = params
		const canvas = await this.getCanvasElement(canvasId, params.moduleId)
		if (!canvas) {
			this.triggerCanvasFailure(bridgeId, params, `drawCanvas:fail canvas ${canvasId} not found`)
			return
		}

		try {
			this.ensureCanvasResolution(canvas)
			const context = canvas.getContext('2d')
			if (!reserve) {
				context.clearRect(0, 0, canvas.width, canvas.height)
			}
			await this.replayCanvasActions(context, actions)
			const result = { errMsg: 'drawCanvas:ok' }
			this.triggerCallback(bridgeId, params.success, [result], result)
			this.triggerCallback(bridgeId, params.complete, [result], result)
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `drawCanvas:fail ${error.message}`)
		}
	}

	async canvasToTempFilePath({ bridgeId, params }) {
		const { canvasId, x = 0, y = 0, width, height, destWidth, destHeight, fileType = 'png', quality = 1 } = params
		const canvas = await this.getCanvasElement(canvasId, params.moduleId)
		if (!canvas) {
			this.triggerCanvasFailure(bridgeId, params, `canvasToTempFilePath:fail canvas ${canvasId} not found`)
			return
		}

		try {
			this.ensureCanvasResolution(canvas)
			const exportWidth = width || canvas.width
			const exportHeight = height || canvas.height
			const outputCanvas = document.createElement('canvas')
			outputCanvas.width = destWidth || exportWidth
			outputCanvas.height = destHeight || exportHeight
			const outputContext = outputCanvas.getContext('2d')
			outputContext.drawImage(
				canvas,
				x,
				y,
				exportWidth,
				exportHeight,
				0,
				0,
				outputCanvas.width,
				outputCanvas.height,
			)

			const mimeType = fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg' : 'image/png'
			const tempFilePath = outputCanvas.toDataURL(mimeType, quality)
			const result = {
				errMsg: 'canvasToTempFilePath:ok',
				tempFilePath,
			}
			this.triggerCallback(bridgeId, params.success, [result], result)
			this.triggerCallback(bridgeId, params.complete, [result], result)
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `canvasToTempFilePath:fail ${error.message}`)
		}
	}

	showToast({ params }) {
		window.__globalAPI.showToast(params)
	}

	hideToast({ params }) {
		window.__globalAPI.hideToast(params)
	}

	addIntersectionObserver(opts) {
		const { bridgeId, params: { targetSelector, relativeInfo, moduleId, options, success } } = opts

		;(async () => {
			await this.ensureModuleRenderReady(moduleId)

			const el = await this.waitForEl(this.instance.get(moduleId))
			if (!el) {
				console.error('[system]', '[render]', 'Failed to find element for intersection observer')
				return
			}
			// 创建所有参考区域的观察器配置
			const observers = []
			for (const info of relativeInfo) {
				const observerOptions = {
					root: null,
					threshold: options.thresholds,
					rootMargin: info.margins,
					initialRatio: options.initialRatio,
					observeAll: options.observeAll,
				}

				if (info.selector === null) {
					// viewport 情况
					observerOptions.root = null
					observers.push({ options: observerOptions })
					continue
				}

				// relativeTo 情况
				const relativeEl = await this.waitForElement(el, info.selector, 'querySelector')
				const targetEls = await this.waitForElement(el, targetSelector, options.observeAll ? 'querySelectorAll' : 'querySelector')

				if (!relativeEl || !targetEls) {
					console.warn('[system]', '[render]', 'Failed to find elements')
					continue
				}

				// 检查是否为祖先关系
				const isAncestor = Array.isArray(targetEls) || targetEls instanceof NodeList
					? Array.from(targetEls).some(target => target && relativeEl.contains(target))
					: relativeEl.contains(targetEls)

				if (isAncestor) {
					// 祖先元素关系，使用标准设置
					observerOptions.root = relativeEl
				}
				else {
					const position = window.getComputedStyle(relativeEl).position
					if (position === 'fixed') {
						// 非祖先关系，且是固定元素，使用 rootMargin 模拟，getBoundingClientRect()或由于祖先的 transform 数据错误
						const computedStyle = window.getComputedStyle(relativeEl)
						const top = Number.parseFloat(computedStyle.top) || 0
						const bottom = top + Number.parseFloat(computedStyle.height) || 0
						const left = Number.parseFloat(computedStyle.left) || 0
						const right = left + Number.parseFloat(computedStyle.width) || 0
						// 计算相对于视口的边距
						observerOptions.root = null
						observerOptions.type = 'fixed'
						observerOptions.rootMargin = `${-top}px ${-(window.innerWidth - right)}px ${-(window.innerHeight - bottom)}px ${-left}px`
					}
					else {
						continue
					}
				}

				observers.push({ options: observerOptions })
			}

			const targetEls = await this.waitForElement(el, targetSelector, options.observeAll ? 'querySelectorAll' : 'querySelector')
			if (!targetEls) {
				console.error('[system]', '[render]', 'Failed to find target element for intersection observer')
				return
			}

			const allObservers = observers.map(({ options }) => {
				let initRatio = options.initialRatio
				const observer = new IntersectionObserver((entries) => {
					entries.forEach((entry) => {
						if (entry.intersectionRatio === initRatio)
							return
						initRatio = entry.intersectionRatio
						// 检查元素是否真的离开视口
						const { top, bottom } = entry.boundingClientRect
						const viewportHeight = window.innerHeight

						// 如果元素还在视口范围内，则不触发回调
						if (!options.type && !entry.isIntersecting
							&& top >= 0
							&& bottom <= viewportHeight) {
							return
						}

						message.send({
							type: 'triggerCallback',
							target: 'service',
							body: {
								bridgeId,
								id: success,
								args: {
									info: {
										boundingClientRect: entry.boundingClientRect, // 目标边界
										intersectionRatio: entry.intersectionRatio, // 相交比例
										intersectionRect: entry.intersectionRect, // 相交区域的边界
										relativeRect: entry.rootBounds, // 相对参考区域
										time: entry.time,
										dataset: entry.target._ds || {},
									},
								},
							},
						})
					})
				}, options)

				if (options.observeAll) {
					Array.from(targetEls).forEach(target => observer.observe(target))
				}
				else {
					observer.observe(targetEls)
				}

				return observer
			})

			const observerId = uuid()
			this.intersectionObservers.set(observerId, allObservers)

			message.send({
				type: 'triggerCallback',
				target: 'service',
				body: {
					bridgeId,
					id: success,
					args: { observerId },
				},
			})
		})()
	}

	removeIntersectionObserver({ params: { observerId } }) {
		if (!observerId) {
			return
		}
		const observers = this.intersectionObservers.get(observerId)
		if (observers) {
			// 断开所有观察器的连接
			observers.forEach(observer => observer.disconnect())
			this.intersectionObservers.delete(observerId)
		}
	}

	addPerformanceObserver() {
		// TODO: 性能观察对象
	}
}

export default new Runtime()
