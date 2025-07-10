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
	ref,
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
		this.intersectionObservers = new Map()

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
				data() {
					return {
						...this.data,
					}
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
					)

					message.send({
						type: 'mC', // createInstance
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
						},
					})

					onMounted(() => {
						nextTick(() => {
							message.send({
								type: 'mR',
								target: 'service',
								body: {
									bridgeId,
									moduleId,
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
					})

					const data = reactive({})
					const initData = await message.wait(moduleId)
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
		const viewModule = this.instance.get(moduleId)

		if (viewModule) {
			for (const key in data) {
				viewModule.$nextTick(() => {
					// 检查属性是否已经存在于组件上
					if (!key.includes('.') && !key.includes('[') && !(key in viewModule)) {
						const refValue = ref(data[key])
						Object.defineProperty(viewModule, key, {
							get() {
								return refValue.value
							},
							set(newValue) {
								refValue.value = newValue
							},
							enumerable: true,
							configurable: true,
						})
					}
					else {
						// 如果属性已存在，直接设置新值
						set(viewModule, key, data[key])
					}
				})
			}
		}
		else {
			console.warn('[system]', '[render]', `module ${moduleId} is not exist.`)
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
		setTimeout(async () => {
			const { bridgeId, params: { targetSelector, relativeInfo, moduleId, options, success } } = opts

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
				const isAncestor = Array.isArray(targetEls)
					? Array.from(targetEls).some(target => relativeEl.contains(target))
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
		// Fixme: 延迟为了解决当前父组件 watch 触发的 nextTick 优先于组件的 created 生命周期导致异常，eg: emit 事件发送先于注册事件执行导致没有回调
		}, 300)
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
