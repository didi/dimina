import { getDataAttributes, set, uuid } from '@dimina/common'
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
	withCtx,
	withDirectives,
} from 'vue'
import loader from './loader'
import message from './message'

class Runtime {
	constructor() {
		this.app = null
		this.pageId = null
		this.instance = new Map()
		this.setupData = new Map()
		this.intersectionObservers = new Map()
		// 追踪"mC 已发出但 service 侧 created 尚未完成"的组件 setup
		// key: moduleId, value: Promise（created 完成时 resolve）
		this._pendingSetups = new Map()
		// 等待特定 moduleId 的 instance 注册到 instance map 的 resolvers
		// key: moduleId, value: resolve[]
		this._instanceWaiters = new Map()

		window._Fragment = Fragment
		window._createTextVNode = createTextVNode
		window._createVNode = createVNode
		window._createBlock = createBlock
		window._createCommentVNode = createCommentVNode
		window._createElementBlock = createElementBlock
		window._createElementVNode = createElementVNode
		window._createSlots = createSlots
		window._normalizeClass = normalizeClass
		window._normalizeStyle = normalizeStyle
		window._openBlock = openBlock
		window._renderList = renderList
		window._renderSlot = renderSlot
		window._resolveComponent = resolveComponent
		window._resolveDirective = resolveDirective
		window._resolveDynamicComponent = resolveDynamicComponent
		window._toDisplayString = toDisplayString
		window._withCtx = withCtx
		window._withDirectives = withDirectives

		window.addEventListener('beforeunload', () => {
			if (this.intersectionObservers.size > 0) {
				for (const observers of this.intersectionObservers.values()) {
					observers.forEach(observer => observer.disconnect())
				}
				this.intersectionObservers.clear()
			}
		})
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

		// 注册页面模板
		for (const [tplName, render] of Object.entries(options.tplComponents)) {
			this.app.component(`dd-${tplName}`, {
				__scopeId: `data-v-${options.id}`,
				props: {
					data: Object,
				},
				setup(props) {
					const state = reactive({})
					watch(
						() => props.data,
						(newData) => {
							if (newData) {
								for (const key in newData) {
									state[key] = newData[key]
								}
							}
						},
						{ immediate: true },
					)
					return state
				},
				render,
			})
		}

		this.app.mount(document.body)
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
						self.instance.set(self.pageId, instance)
						// instance 已注册，通知等待方
						if (self._instanceWaiters.has(self.pageId)) {
							self._instanceWaiters.get(self.pageId).forEach(r => r(instance))
							self._instanceWaiters.delete(self.pageId)
						}

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
								})
							})

							onUnmounted(() => {
								window.removeEventListener('scroll', handleScroll)
							})

						const data = reactive({})
						self.setupData.set(self.pageId, data)
						const initData = await message.wait(self.pageId)
						const entries = Object.entries(initData)
						for (let i = 0; i < entries.length; i++) {
							const [key, value] = entries[i]
							set(data, key, value)
						}
						return data
					},
					components,
					render: pageModule.moduleInfo.render,
					},
				},

			},
		}
	}

	createComponent(path, bridgeId, usingComponents, depthChain = []) {
		// 循环依赖检测（A -> B -> A）
		if (depthChain.includes(path)) {
			console.warn('[render]', `检测到循环依赖: ${[...depthChain, path].join(' -> ')}`)
			return {}
		}

		if (!usingComponents || Object.keys(usingComponents).length === 0) {
			return
		}

		const components = {}
		const self = this
		const newDepthChain = [...depthChain, path]

		for (const [componentName, componentPath] of Object.entries(usingComponents)) {
			const module = loader.getModuleByPath(componentPath)
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
					const parentId = parentInfo.id
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

				const instance = getCurrentInstance().proxy
				self.instance.set(moduleId, instance)
				// instance 已注册，通知 addIntersectionObserver 中可能正在等待的调用方
				if (self._instanceWaiters.has(moduleId)) {
					self._instanceWaiters.get(moduleId).forEach(r => r(instance))
					self._instanceWaiters.delete(moduleId)
				}

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

				// mC 发出，service 侧开始异步执行 created；记录此 moduleId 为 pending 状态，
				// message.wait 解除后（service created 完成）才从 pending 中移除
				let _pendingResolve
				self._pendingSetups.set(moduleId, new Promise(r => (_pendingResolve = r)))

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
					self.instance.delete(moduleId)
					self.setupData.delete(moduleId)
				})

			const data = reactive({})
			self.setupData.set(moduleId, data)
			
		watch(
				props,
				(newProps) => {
					Object.assign(data, newProps)
					message.send({
						type: 't',
						target: 'service',
						body: {
							bridgeId,
							moduleId,
							methodName: 'tO', // triggerObserver
							event: deepToRaw(newProps),
						},
					})
				},
				{
					immediate: true,
				}
			)
					
				const initData = await message.wait(moduleId)
				// service 侧 created/attached 已完成，从 pending map 中移除并通知等待者
				self._pendingSetups.delete(moduleId)
				_pendingResolve()
				const entries = Object.entries(initData)
				for (let i = 0; i < entries.length; i++) {
					const [key, value] = entries[i]
					set(data, key, value)
				}
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
			for (const key in data) {
				set(setupData, key, data[key])
			}
		}
		else {
			console.warn('[system]', '[render]', `module ${moduleId} is not exist.`)
		}
	}

	/**
	 * 等待特定 moduleId 的 Vue instance 注册到 this.instance map，
	 * 用于 addIntersectionObserver 调用早于 setup 执行的场景（如 Page.onLoad）
	 */
	_waitForInstance(moduleId, timeout = 500) {
		const existing = this.instance.get(moduleId)
		if (existing) {
			return Promise.resolve(existing)
		}
		return new Promise((resolve) => {
			const waiters = this._instanceWaiters.get(moduleId) || []
			waiters.push(resolve)
			this._instanceWaiters.set(moduleId, waiters)
			setTimeout(() => {
				// 超时：从等待队列中移除并 resolve undefined
				const w = this._instanceWaiters.get(moduleId)
				if (w) {
					const idx = w.indexOf(resolve)
					if (idx !== -1) w.splice(idx, 1)
					if (w.length === 0) this._instanceWaiters.delete(moduleId)
				}
				resolve(undefined)
			}, timeout)
		})
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
		if (elements) {
			return elements
		}
		return new Promise((resolve) => {
			const observer = new MutationObserver((_, obs) => {
				const elements = parent[method](selector)
				if (elements) {
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
			const { left, top, right, bottom, width, height } = targetElement.getBoundingClientRect()
			data.left = left
			data.top = top
			data.right = right
			data.bottom = bottom
			data.width = width
			data.height = height
		}

		if (fields.size) {
			data.width = targetElement.offsetWidth
			data.height = targetElement.offsetHeight
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

	showToast({ params }) {
		window.__globalAPI.showToast(params)
	}

	hideToast({ params }) {
		window.__globalAPI.hideToast(params)
	}

	addIntersectionObserver(opts) {
		(async () => {
			const { bridgeId, params: { targetSelector, relativeInfo, moduleId, options, success } } = opts

			// 先等 moduleId 对应的 Vue instance 注册（处理 Page.onLoad 等早于 setup 执行的场景）
			const instance = await this._waitForInstance(moduleId)
			const el = await this.waitForEl(instance)
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

			// 目标 DOM 已出现，等待所有 pending setup 完成（service 侧 created/attached 执行完毕），
			// 但排除 observer 调用方自身（moduleId），避免在 created/onLoad 内调用时产生循环等待。
			// 这保证了：IntersectionObserver 首次回调到达 service 时，目标 DOM 内子组件的
			// 生命周期钩子（如 EventBus.once 注册）已就绪。
			const pendingExceptSelf = Array.from(this._pendingSetups.entries())
				.filter(([id]) => id !== moduleId)
				.map(([, promise]) => promise)
			if (pendingExceptSelf.length > 0) {
				await Promise.all(pendingExceptSelf)
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
