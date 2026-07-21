import { deepEqual, getDataAttributes, normalizePropertyValues as normalizeMiniProgramPropertyValues, set, uuid } from '@dimina/common'
import { Components, deepToRaw, triggerEvent } from '@dimina/components'
import {
	createApp,
	createBlock,
	createCommentVNode,
	createElementBlock,
	createElementVNode,
	createTextVNode,
	createVNode,
	cloneVNode,
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
import { createMiniProgramSlots } from './slots'

const COMPONENT_HOST_ATTRIBUTE = 'data-dd-component-host'
const STYLE_ISOLATION_ATTRIBUTE = 'data-dd-style-isolation'
const STYLE_HOST_ATTRIBUTE = 'data-dd-style-host'
const WXML_STYLE_PROP = 'diminaWxmlStyle'

// 小程序 data 允许在运行期新增顶层字段。让 Vue 将尚不存在的公开字段视为可读，
// 既能在首次访问时建立响应式依赖，也不会产生“未定义实例属性”的无效告警。
function createTemplateData() {
	const data = reactive({})
	const templateData = new Proxy(data, {
		getOwnPropertyDescriptor(target, key) {
			return Reflect.getOwnPropertyDescriptor(target, key) || (
				typeof key === 'string' && !key.startsWith('$') && !key.startsWith('_')
					? { configurable: true, enumerable: false, value: undefined }
					: undefined
			)
		},
	})
	return { data, templateData }
}

function normalizeStyleIsolation(value) {
	if (value === 'shared') {
		return 'shared'
	}
	if (value === 'apply-shared') {
		return 'apply-shared'
	}
	return 'isolated'
}

function acceptsGlobalStyles(styleIsolation) {
	return styleIsolation === 'apply-shared' || styleIsolation === 'shared'
}

function markComponentHost(vnode, styleIsolation, styleScopeId) {
	if (!vnode || typeof vnode !== 'object') {
		return vnode
	}
	return cloneVNode(vnode, {
		[COMPONENT_HOST_ATTRIBUTE]: '',
		[STYLE_ISOLATION_ATTRIBUTE]: styleIsolation,
		[STYLE_HOST_ATTRIBUTE]: styleScopeId,
	})
}

function addStyleHostToken(element, styleScopeId) {
	const tokens = new Set((element.getAttribute(STYLE_HOST_ATTRIBUTE) || '').split(/\s+/).filter(Boolean))
	tokens.add(styleScopeId)
	element.setAttribute(STYLE_HOST_ATTRIBUTE, [...tokens].join(' '))
}

function normalizeEventAttributes(attrs = {}) {
	const eventAttr = {}
	for (const [attrName, handler] of Object.entries(attrs)) {
		const match = attrName.match(/^(capture-)?(bind|catch)(?::)?(.+)$/)
		if (!match || handler === undefined || handler === null || handler === '') {
			continue
		}

		const [, capture, listenerType, eventType] = match
		const bindingType = capture
			? (listenerType === 'catch' ? 'captureCatch' : 'captureBind')
			: listenerType
		eventAttr[eventType] = eventAttr[eventType] || {}
		eventAttr[eventType][bindingType] = handler
	}
	return eventAttr
}

function orderEventBindingRecords(records = []) {
	const remaining = [...records]
	const ordered = []
	while (remaining.length > 0) {
		// 多个 Vue 组件可能共用一个根 DOM。若 A.owner === B.target，
		// A 在 B 的组件内部，冒泡时应先于 B 执行。
		const innerIndex = remaining.findIndex(candidate => !remaining.some(other => (
			other !== candidate && other.owner === candidate.target
		)))
		ordered.push(...remaining.splice(innerIndex >= 0 ? innerIndex : 0, 1))
	}
	return ordered
}

function isElementNode(node) {
	return node?.nodeType === 1 && typeof node.setAttribute === 'function'
}

function applyStyleScopeAttributes(root, scopeIds, inheritedAccess, pageScopeId) {
	if (!isElementNode(root)) {
		return
	}

	const visit = (element, canReceiveInheritedStyles) => {
		const isComponentHost = element.hasAttribute(COMPONENT_HOST_ATTRIBUTE)
		const hostAcceptsGlobalStyles = isComponentHost
			&& acceptsGlobalStyles(normalizeStyleIsolation(element.getAttribute(STYLE_ISOLATION_ATTRIBUTE)))
		const isPageOwnedNode = pageScopeId && element.hasAttribute(pageScopeId)
		const receivesGlobalStyles = canReceiveInheritedStyles || hostAcceptsGlobalStyles || isPageOwnedNode
		if (receivesGlobalStyles) {
			for (const scopeId of scopeIds) {
				element.setAttribute(scopeId, '')
			}
		}
		const childAccess = isComponentHost ? hostAcceptsGlobalStyles : receivesGlobalStyles
		for (const child of element.children) {
			visit(child, childAccess)
		}
	}

	visit(root, inheritedAccess)
}

function canReceiveStylesFromParent(node, ownerRoot, pageScopeId) {
	let current = node.parentElement
	while (current) {
		if (current.hasAttribute(COMPONENT_HOST_ATTRIBUTE)) {
			return acceptsGlobalStyles(
				normalizeStyleIsolation(current.getAttribute(STYLE_ISOLATION_ATTRIBUTE)),
			)
		}
		if (pageScopeId && current.hasAttribute(pageScopeId)) {
			return true
		}
		if (current === ownerRoot) {
			return true
		}
		current = current.parentElement
	}
	return false
}

function observeStyleScopeRoot(root, scopeIds, pageScopeId) {
	if (!isElementNode(root) || scopeIds.length === 0) {
		return null
	}
	applyStyleScopeAttributes(root, scopeIds, true, pageScopeId)

	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!isElementNode(node)) {
					continue
				}
				applyStyleScopeAttributes(
					node,
					scopeIds,
					canReceiveStylesFromParent(node, root, pageScopeId),
					pageScopeId,
				)
			}
		}
	})
	observer.observe(root, { childList: true, subtree: true })
	return observer
}

function collectVNodeRootElements(vnode, result = []) {
	if (!vnode) {
		return result
	}
	if (Array.isArray(vnode)) {
		for (const child of vnode) collectVNodeRootElements(child, result)
		return result
	}
	if (vnode.component?.subTree) {
		return collectVNodeRootElements(vnode.component.subTree, result)
	}
	if (vnode.suspense?.activeBranch) {
		return collectVNodeRootElements(vnode.suspense.activeBranch, result)
	}
	if (vnode.type === Fragment) {
		return collectVNodeRootElements(vnode.children, result)
	}
	if (isElementNode(vnode.el) && !result.includes(vnode.el)) {
		result.push(vnode.el)
	}
	return result
}

function installStyleScopeSync(roots, scopeIds, pageScopeId) {
	const normalizedScopeIds = [...new Set(scopeIds.filter(Boolean))]
	const observers = roots
		.map(root => observeStyleScopeRoot(root, normalizedScopeIds, pageScopeId))
		.filter(Boolean)
	return () => observers.forEach(observer => observer.disconnect())
}

function hasVNodeProp(vnodeProps, name) {
	if (!vnodeProps) return false
	if (Object.prototype.hasOwnProperty.call(vnodeProps, name)) return true
	const kebabName = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
	return Object.prototype.hasOwnProperty.call(vnodeProps, kebabName)
}

function getVNodeProp(vnodeProps, name) {
	if (!vnodeProps) return undefined
	if (Object.prototype.hasOwnProperty.call(vnodeProps, name)) return vnodeProps[name]
	const kebabName = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
	return vnodeProps[kebabName]
}

export function applyWxmlStyleProperty(propertySchemas, values, vnode) {
	const normalizedValues = { ...values }
	if (propertySchemas?.style && hasVNodeProp(vnode?.props, WXML_STYLE_PROP)) {
		normalizedValues.style = getVNodeProp(vnode.props, WXML_STYLE_PROP)
	}
	delete normalizedValues[WXML_STYLE_PROP]
	return normalizedValues
}

export function normalizeStaticBooleanAttributes(propertySchemas, values, vnode) {
	const normalizedValues = { ...values }
	const dynamicProps = new Set(vnode?.dynamicProps || [])

	for (const [name, schema] of Object.entries(propertySchemas || {})) {
		if (schema.type !== Boolean || normalizedValues[name] !== '' || !hasVNodeProp(vnode?.props, name)) {
			continue
		}

		const kebabName = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
		if (!dynamicProps.has(name) && !dynamicProps.has(kebabName)) {
			// Vue compiles a valueless custom-component attribute (for example
			// <t-button loading>) to an empty string. WXML treats the static
			// presence of a declared Boolean property as true. Dynamic bindings
			// still use normal mini-program type conversion, where '' is false.
			normalizedValues[name] = true
		}
	}

	return normalizedValues
}

// Keep these aliases in sync with @vue/compiler-core helperNameMap/aliasHelper output.
const VUE_RUNTIME_HELPERS = {
	_Fragment: Fragment,
	_createTextVNode: createTextVNode,
	_createVNode: createVNode,
	_createBlock: createBlock,
	_createCommentVNode: createCommentVNode,
	_createElementBlock: createElementBlock,
	_createElementVNode: createElementVNode,
	_createSlots: createMiniProgramSlots,
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

const CANVAS_NODE_TYPE = 'dimina-canvas-node'
const TYPED_ARRAY_CTORS = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
}

const WEBGL_PARAMETER_NAMES = [
	'VERSION',
	'SHADING_LANGUAGE_VERSION',
	'VENDOR',
	'RENDERER',
	'MAX_VIEWPORT_DIMS',
	'ALIASED_POINT_SIZE_RANGE',
	'ALIASED_LINE_WIDTH_RANGE',
	'COMPRESSED_TEXTURE_FORMATS',
	'MAX_TEXTURE_SIZE',
	'MAX_CUBE_MAP_TEXTURE_SIZE',
	'MAX_RENDERBUFFER_SIZE',
	'MAX_VERTEX_ATTRIBS',
	'MAX_TEXTURE_IMAGE_UNITS',
	'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
	'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
	'MAX_VERTEX_UNIFORM_VECTORS',
	'MAX_FRAGMENT_UNIFORM_VECTORS',
	'MAX_VARYING_VECTORS',
	'RED_BITS',
	'GREEN_BITS',
	'BLUE_BITS',
	'ALPHA_BITS',
	'DEPTH_BITS',
	'STENCIL_BITS',
	'SUBPIXEL_BITS',
	'SAMPLE_BUFFERS',
	'SAMPLES',
	'MAX_3D_TEXTURE_SIZE',
	'MAX_ARRAY_TEXTURE_LAYERS',
	'MAX_COLOR_ATTACHMENTS',
	'MAX_DRAW_BUFFERS',
	'MAX_ELEMENT_INDEX',
	'MAX_ELEMENTS_INDICES',
	'MAX_ELEMENTS_VERTICES',
	'MAX_FRAGMENT_INPUT_COMPONENTS',
	'MAX_SAMPLES',
	'MAX_SERVER_WAIT_TIMEOUT',
	'MAX_TEXTURE_LOD_BIAS',
	'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS',
	'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS',
	'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS',
	'MAX_UNIFORM_BLOCK_SIZE',
	'MAX_UNIFORM_BUFFER_BINDINGS',
	'MAX_VARYING_COMPONENTS',
	'MAX_VERTEX_OUTPUT_COMPONENTS',
	'UNIFORM_BUFFER_OFFSET_ALIGNMENT',
]

const WEBGL_PRECISION_NAMES = [
	'LOW_FLOAT',
	'MEDIUM_FLOAT',
	'HIGH_FLOAT',
	'LOW_INT',
	'MEDIUM_INT',
	'HIGH_INT',
]

function collectNumericConstants(value) {
	const constants = {}
	const visited = new Set()
	for (let current = value; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
		for (const name of Object.getOwnPropertyNames(current)) {
			if (visited.has(name) || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
				continue
			}
			visited.add(name)
			try {
				if (typeof value[name] === 'number') {
					constants[name] = value[name]
				}
			}
			catch {
				// Ignore host object properties that cannot be read in this WebView.
			}
		}
	}
	return constants
}

function serializeCanvasResult(value, resolveResourceId) {
	if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value
	}
	const resourceId = resolveResourceId?.(value)
	if (resourceId) {
		return { __canvasResourceId: resourceId }
	}
	if (ArrayBuffer.isView(value)) {
		return {
			__canvasTypedArray: value.constructor.name,
			data: Array.from(value),
		}
	}
	if (Array.isArray(value)) {
		return value.map(item => serializeCanvasResult(item, resolveResourceId))
	}
	if (typeof value === 'object') {
		const result = {}
		const keys = new Set(Object.keys(value))
		for (const key of ['alpha', 'antialias', 'depth', 'desynchronized', 'failIfMajorPerformanceCaveat', 'powerPreference', 'premultipliedAlpha', 'preserveDrawingBuffer', 'stencil', 'name', 'precision', 'rangeMax', 'rangeMin', 'size', 'type']) {
			if (key in value) {
				keys.add(key)
			}
		}
		for (const key of keys) {
			const serialized = serializeCanvasResult(value[key], resolveResourceId)
			if (serialized !== undefined) {
				result[key] = serialized
			}
		}
		return result
	}
	return undefined
}

function describeWebGLContext(context, includeExtensionConstants = true) {
	if (!context) {
		return null
	}
	const constants = collectNumericConstants(context)
	const parameters = {}
	for (const name of WEBGL_PARAMETER_NAMES) {
		const pname = context[name]
		if (typeof pname !== 'number') {
			continue
		}
		try {
			parameters[pname] = serializeCanvasResult(context.getParameter(pname))
		}
		catch {
			// A capability is optional when the current WebGL version does not expose it.
		}
	}

	let supportedExtensions = []
	try {
		supportedExtensions = context.getSupportedExtensions?.() || []
	}
	catch {
		// Treat an unavailable extension list as empty.
	}
	const extensions = {}
	for (const name of supportedExtensions) {
		if (!includeExtensionConstants) {
			extensions[name] = { constants: {} }
			continue
		}
		try {
			const extension = context.getExtension(name)
			extensions[name] = {
				constants: extension ? collectNumericConstants(extension) : {},
			}
		}
		catch {
			extensions[name] = { constants: {} }
		}
	}

	const shaderPrecisionFormats = {}
	for (const shaderName of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) {
		for (const precisionName of WEBGL_PRECISION_NAMES) {
			const shaderType = context[shaderName]
			const precisionType = context[precisionName]
			if (typeof shaderType !== 'number' || typeof precisionType !== 'number') {
				continue
			}
			try {
				const format = context.getShaderPrecisionFormat(shaderType, precisionType)
				if (format) {
					shaderPrecisionFormats[`${shaderType}:${precisionType}`] = serializeCanvasResult(format)
				}
			}
			catch {
				// Keep unsupported precision combinations out of the snapshot.
			}
		}
	}

	let contextAttributes = null
	try {
		contextAttributes = serializeCanvasResult(context.getContextAttributes?.())
	}
	catch {
		// Context attributes remain unknown if the host does not expose them.
	}

	return {
		supported: true,
		constants,
		parameters,
		contextAttributes,
		supportedExtensions,
		extensions,
		shaderPrecisionFormats,
		drawingBufferWidth: context.drawingBufferWidth,
		drawingBufferHeight: context.drawingBufferHeight,
		contextLost: Boolean(context.isContextLost?.()),
	}
}

function probeWebGLCapabilities() {
	const capabilities = {}
	for (const contextType of ['webgl', 'webgl2']) {
		const canvas = document.createElement('canvas')
		canvas.width = 1
		canvas.height = 1
		let context = null
		try {
			context = canvas.getContext(contextType)
			if (!context && contextType === 'webgl') {
				context = canvas.getContext('experimental-webgl')
			}
		}
		catch {
			// WebGL can be disabled by the WebView or device policy.
		}
		capabilities[contextType] = context ? describeWebGLContext(context) : { supported: false }
		try {
			context?.getExtension?.('WEBGL_lose_context')?.loseContext?.()
		}
		catch {
			// The temporary probe context will be reclaimed normally.
		}
	}
	return capabilities
}

function isCanvasElement(element) {
	return element?.tagName?.toLowerCase() === 'canvas'
}

class Runtime {
	constructor() {
		this.app = null
		this.pageId = null
		this.instance = new Map()
		this.moduleIds = new WeakMap()
		this.moduleRootIds = new WeakMap()
		this.setupData = new Map()
		this.initializedModules = new Set()
		this.preInitUpdates = new Map()
		this.intersectionObservers = new Map()
		this.mediaQueryObservers = new Map()
		this.componentAnimations = new Map()
		this.performanceObservers = new Map()
		this.canvasNodes = new Map()
		this.canvasResources = new Map()
		this.canvasRafIds = new Map()
		this.canvasCapabilities = null
		// 追踪"mC 已发出但 service 侧 created 尚未完成"的组件 setup
		// key: moduleId, value: Promise（created 完成时 resolve）
		this._pendingSetups = new Map()
		// 等待特定 moduleId 的 instance 注册到 instance map 的 resolvers
		// key: moduleId, value: resolve[]
		this._instanceWaiters = new Map()
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
		for (const { mediaQueryList, listener } of this.mediaQueryObservers.values()) {
			mediaQueryList.removeEventListener?.('change', listener)
			mediaQueryList.removeListener?.(listener)
		}
		this.mediaQueryObservers.clear()
		for (const animations of this.componentAnimations.values()) {
			animations.forEach(animation => animation.cancel())
		}
		this.componentAnimations.clear()
		for (const observer of this.performanceObservers.values()) {
			observer.disconnect()
		}
		this.performanceObservers.clear()
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

		const { id, tplComponents = {}, usingComponents = {}, componentPlaceholder = {} } = module.moduleInfo
		const components = this.createComponent(path, bridgeId, usingComponents, new Map(), componentPlaceholder)
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
				const { data: state, templateData } = createTemplateData()
				watchEffect(() => {
					const newData = props.data || {}
					for (const key in state) {
						if (!(key in newData)) delete state[key]
					}
					Object.assign(state, newData)
				})
				return templateData
			},
			render,
		}
	}

	// Component create -> Page create -> Page attached -> Component attached -> Component ready -> Page ready
	// Component attached -> Page onLoad -> Page onShow -> Component ready -> onReady
	makeOptions(opts) {
		const { path, bridgeId, pageId } = opts
		const pageModule = loader.getModuleByPath(path)
		const {
			id,
			appStyleScopeId,
			sharedStyleScopeIds = [],
			usingComponents,
			componentPlaceholder = {},
			tplComponents,
			customTabBar,
		} = pageModule.moduleInfo
		const pageRender = pageModule.moduleInfo.render
		const customTabBarComponentName = customTabBar?.componentName
		const hasCustomTabBar = typeof customTabBarComponentName === 'string'
			&& Object.prototype.hasOwnProperty.call(usingComponents || {}, customTabBarComponentName)
		this.pageId = pageId
		const that = this
		const rootCom = 'dd-page'
		const sId = `data-v-${id}`
		const globalStyleScopeIds = [
			appStyleScopeId ? `data-v-${appStyleScopeId}` : null,
			sId,
			...sharedStyleScopeIds.map(scopeId => `data-v-${scopeId}`),
		].filter(Boolean)
		const components = this.createComponent(path, bridgeId, usingComponents, new Map(), componentPlaceholder)
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
						default: () => h(_component_dd_page),
						// fallback: () => h('div', 'Loading...'),
					})
				},
				components: {
					[rootCom]: {
						name: path,
						__scopeId: sId,
						async setup(_props, { expose }) {
							expose()
							const vueInstance = getCurrentInstance()
							provide('bridgeId', bridgeId)
							provide('path', path)
							provide(path, {
								id: that.pageId,
							})
							provide('info', {
								id: that.pageId,
								sId,
							})
							const instance = vueInstance.proxy
							instance.__page__ = true
							that.setModuleInstance(that.pageId, instance)
							let stopStyleScopeSync = () => {}

							let ticking = false
							const handleScroll = () => {
								if (!ticking) {
									window.requestAnimationFrame(() => {
										message.send({
											type: 'pageScroll',
											target: 'service',
											body: {
												bridgeId,
												moduleId: that.pageId,
												scrollTop: window.scrollY,
											},
										})
										ticking = false
									})
									ticking = true
								}
							}

							onMounted(() => {
								stopStyleScopeSync = installStyleScopeSync(
									collectVNodeRootElements(vueInstance.subTree),
									globalStyleScopeIds,
									sId,
								)
								window.addEventListener('scroll', handleScroll, { passive: true })
								nextTick(() => {
									message.send({
										type: 'pageReady',
										target: 'service',
										body: {
											bridgeId,
											moduleId: that.pageId,
										},
									})
								})
							})

							onUnmounted(() => {
								stopStyleScopeSync()
								window.removeEventListener('scroll', handleScroll)
							})

						const { data, templateData } = createTemplateData()
						that.setupData.set(that.pageId, data)
						const initData = await message.wait(that.pageId)
						that.applyInitialData(that.pageId, data, initData)
						return templateData
					},
					components,
					render: hasCustomTabBar
						? function (...args) {
							const pageVNode = pageRender.apply(this, args)
							const CustomTabBar = resolveComponent(`dd-${customTabBarComponentName}`)
							return h(Fragment, null, [pageVNode, h(CustomTabBar)])
						}
						: pageRender,
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
			const pendingData = pendingUpdate.data || pendingUpdate
			if ((pendingUpdate.changes || []).length > 0) {
				for (const change of pendingUpdate.changes) {
					set(data, change.path, change.value)
				}
			}
			else {
				for (const [key, value] of Object.entries(pendingData)) {
					set(data, key, value)
				}
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
			if (accessCache && Object.prototype.hasOwnProperty.call(accessCache, key)) {
				delete accessCache[key]
			}
			if (ctx && !Object.prototype.hasOwnProperty.call(ctx, key)) {
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
		if (this._instanceWaiters.has(moduleId)) {
			this._instanceWaiters.get(moduleId).forEach(resolve => resolve(instance))
			this._instanceWaiters.delete(moduleId)
		}
	}

	deleteModuleInstance(moduleId) {
		const instance = this.instance.get(moduleId)
		if (instance) {
			this.moduleIds.delete(instance)
		}
		this.instance.delete(moduleId)
	}

	registerModuleRoots(moduleId, roots) {
		for (const root of roots) {
			const moduleIds = this.moduleRootIds.get(root) || []
			if (!moduleIds.includes(moduleId)) {
				moduleIds.push(moduleId)
				this.moduleRootIds.set(root, moduleIds)
			}
		}
	}

	unregisterModuleRoots(moduleId, roots) {
		for (const root of roots) {
			const moduleIds = this.moduleRootIds.get(root)
			if (!moduleIds) {
				continue
			}
			const nextModuleIds = moduleIds.filter(id => id !== moduleId)
			if (nextModuleIds.length > 0) {
				this.moduleRootIds.set(root, nextModuleIds)
			}
			else {
				this.moduleRootIds.delete(root)
			}
		}
	}

	getRenderParentModuleId(roots, moduleId) {
		for (const root of roots) {
			let element = root.parentElement
			while (element) {
				const moduleIds = this.moduleRootIds.get(element) || []
				const parentId = moduleIds.findLast(id => id !== moduleId)
				if (parentId) {
					return parentId
				}
				element = element.parentElement
			}
		}
	}

	collectCustomEventPath(root, targetModuleId) {
		const eventPath = []
		let element = root
		while (element) {
			for (const record of orderEventBindingRecords(element._ddEventBindings)) {
				const moduleId = this.moduleIds.get(record.owner)
				const nodeModuleId = this.moduleIds.get(record.target)
				if (!moduleId) {
					continue
				}

				const isComponentHost = record.nodeType === 'component'
				// Vue 会把组件宿主与组件内部的单根节点折叠到同一 DOM
				// 元素上。事件从宿主节点开始，不应反向进入目标组件自身的内部根节点。
				if (element === root && !isComponentHost && moduleId === targetModuleId) {
					continue
				}
				// 目标组件宿主的绑定已通过 mC 传入 service，这里只保留祖先路径。
				if (isComponentHost && nodeModuleId === targetModuleId) {
					continue
				}

				eventPath.push({
					moduleId,
					nodeModuleId,
					isComponentHost,
					eventAttr: record.eventAttr,
					targetInfo: {
						id: element.id,
						dataset: { ...element.dataset, ...element._ds },
					},
				})
			}
			element = element.parentElement
		}
		return eventPath
	}

	createComponent(path, bridgeId, usingComponents, componentCache = new Map(), componentPlaceholder = {}) {
		if (!usingComponents || Object.keys(usingComponents).length === 0) {
			return
		}

		const components = {}
		const that = this

		for (const [componentName, componentPath] of Object.entries(usingComponents)) {
			let resolvedComponentPath = componentPath
			let cacheKey = `${path}\0${resolvedComponentPath}`
			let cachedComponent = componentCache.get(cacheKey)
			if (cachedComponent) {
				components[`dd-${componentName}`] = cachedComponent
				continue
			}

			let module = loader.getModuleByPath(resolvedComponentPath)
			if (!module?.moduleInfo) {
				const placeholderName = componentPlaceholder[componentName]
				const placeholderPath = placeholderName && usingComponents[placeholderName]
				if (placeholderPath) {
					resolvedComponentPath = placeholderPath
					cacheKey = `${path}\0${resolvedComponentPath}`
					cachedComponent = componentCache.get(cacheKey)
					if (cachedComponent) {
						components[`dd-${componentName}`] = cachedComponent
						continue
					}
					module = loader.getModuleByPath(resolvedComponentPath)
				}
			}

			// Cache component options by declaring path and resolved target/placeholder path. Registering
			// the option before walking its children closes self and mutual cycles,
			// while retaining the lexical declaring path used by setup below.
			if (!module?.moduleInfo) {
				continue
			}

			const {
				id,
				usingComponents: subUsing,
				componentPlaceholder: subPlaceholder = {},
				customTabBar,
			} = module.moduleInfo
			const sId = `data-v-${id}`
			const styleIsolation = normalizeStyleIsolation(module.moduleInfo.styleIsolation)

			// setup -> beforeCreate -> beforeMount
			const componentOptions = {
				name: resolvedComponentPath,
				__scopeId: sId,
				components: undefined,
				props: {
					...module.props,
					[WXML_STYLE_PROP]: { type: null },
				},
				async setup(props, { attrs, expose }) {
					const parentInfo = inject('info')
					const parentPath = inject('path')
					const vueInstance = getCurrentInstance()
					// External classes belong to the component that lexically declared the
					// child vnode. Slots can change the nearest Vue parent, so prefer the
					// vnode scope over the injected render-parent scope.
					const externalClassScopeId = vueInstance.vnode.scopeId || parentInfo.sId

					expose({
						props,
						sId: externalClassScopeId,
					})
					const vueParentId = that.getParentModuleId(vueInstance)
					const parentId = vueParentId || parentInfo.id
					const pageInfo = inject(path, null)
					// Slot content keeps the lexical event owner from the component that
					// declared it, even when Vue renders it below a different component.
					// A globally reused template may not have that lexical provider, so only
					// then fall back to the nearest runtime component/page instance.
					const pageId = pageInfo?.id || parentId
					const pagePath = pageInfo ? path : parentPath
					const moduleId = `${id}_${uuid()}`
					provide('info', {
						id: moduleId,
						sId,
					})
					provide('path', resolvedComponentPath)
					provide(resolvedComponentPath, {
						id: moduleId,
						pagePath, // 声明该组件的页面或组件路径
						pageId,
					})
					const instance = vueInstance.proxy
					that.setModuleInstance(moduleId, instance)
					const normalizeCurrentProperties = () => normalizeMiniProgramPropertyValues(
						module.propertySchemas,
						normalizeStaticBooleanAttributes(
							module.propertySchemas,
							applyWxmlStyleProperty(module.propertySchemas, deepToRaw(props), vueInstance.vnode),
							vueInstance.vnode,
						),
						{
							isAbsent: name => (
								!hasVNodeProp(vueInstance.vnode.props, name)
								&& !(name === 'style' && hasVNodeProp(vueInstance.vnode.props, WXML_STYLE_PROP))
							),
							warn: warning => console.warn('[system]', '[render]', warning),
						},
					)

					const externalClasses = []
					for (const [k, v] of Object.entries(module.props ?? {})) {
						if (v.cls) {
							// 自定义组件的外部样式类，通过 v-c-class 自定义指令处理
							externalClasses.push(k)
						}
					}
					provide('externalClasses', externalClasses)

					const eventAttr = normalizeEventAttributes(attrs)

					const initialProperties = normalizeCurrentProperties()
					const propertyNames = Object.keys(module.propertySchemas || {}).filter(name => (
						hasVNodeProp(vueInstance.vnode.props, name)
						|| (name === 'style' && hasVNodeProp(vueInstance.vnode.props, WXML_STYLE_PROP))
					))

					// Service lifecycle dispatch is synchronous. Register the one-shot data
					// listener before mC so a same-stack response cannot be lost.
					const initDataPromise = message.waitAndSend(moduleId, {
						type: 'mC', // createInstance + componentCreated
						target: 'service',
						body: {
							bridgeId,
							moduleId,
							path: resolvedComponentPath,
							isCustomTabBar: customTabBar === true,
							pageId,
							parentId,
							eventAttr,
							targetInfo: {
								dataset: getDataAttributes(attrs, deepToRaw),
								id: attrs.id,
								class: attrs.class,
							},
							properties: initialProperties,
							propertyNames,
							propBindings: null, // 初始化时为 null，稍后从 DOM 元素读取
						},
					})

					// Track the component until its initial data has returned from service.
					let _pendingResolved = false
					let _resolvePending
					const _pendingResolve = () => {
						if (_pendingResolved) {
							return
						}
						_pendingResolved = true
						_resolvePending?.()
					}
					that._pendingSetups.set(moduleId, new Promise(r => (_resolvePending = r)))

					onMounted(() => {
						const roots = collectVNodeRootElements(vueInstance.subTree)
						that.registerModuleRoots(moduleId, roots)
						for (const root of roots) {
							root.setAttribute(COMPONENT_HOST_ATTRIBUTE, '')
							root.setAttribute(STYLE_ISOLATION_ATTRIBUTE, styleIsolation)
							addStyleHostToken(root, id)
						}
						nextTick(() => {
							// Slot content keeps its lexical Vue parent, while mini-program
							// relations follow the rendered component tree. Resolve the
							// physical parent after every mounted hook has registered roots.
							const renderParentId = that.getRenderParentModuleId(roots, moduleId)
							message.send({
								type: 'mA',
								target: 'service',
								body: {
									bridgeId,
									moduleId,
									parentId: renderParentId || parentId,
								},
							})
							// 从 DOM 元素读取属性绑定信息
							const propBindings = instance.$el?._propBindings
							const eventPath = that.collectCustomEventPath(instance.$el, moduleId)

							message.send({
								type: 'mR',
								target: 'service',
								body: {
									bridgeId,
									moduleId,
									propBindings, // 传递从指令中读取的绑定信息
									eventPath,
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

					let unregisterFormControl
					onUnmounted(() => {
						unregisterFormControl?.()
						const roots = collectVNodeRootElements(vueInstance.subTree)
						that.unregisterModuleRoots(moduleId, roots)
						message.send({
							type: 'mU',
							target: 'service',
							body: {
								bridgeId,
								moduleId,
							},
						})
						that.deleteModuleInstance(moduleId)
						that.setupData.delete(moduleId)
						that.initializedModules.delete(moduleId)
						that.preInitUpdates.delete(moduleId)
						that._pendingSetups.delete(moduleId)
						_pendingResolve()
					})

					const { data, templateData } = createTemplateData()
					that.setupData.set(moduleId, data)
					if (module.builtinBehaviors?.has('wx://form-field')) {
						unregisterFormControl = inject('registerFormControl', undefined)?.({
							getName: () => Object.prototype.hasOwnProperty.call(data, 'name') ? data.name : props.name,
							getValue: () => Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : props.value,
						})
					}
					let previousNormalizedProps = initialProperties
					let isInitialPropsWatch = true

					watch(
						() => deepToRaw(props),
						() => {
							const newProps = isInitialPropsWatch
								? initialProperties
								: normalizeCurrentProperties()
							Object.assign(data, newProps)
							if (isInitialPropsWatch) {
								isInitialPropsWatch = false
								return
							}

							const changedProps = Object.entries(newProps).reduce((acc, [key, value]) => {
								if (!deepEqual(value, previousNormalizedProps[key])) {
									acc[key] = value
								}
								return acc
							}, {})
							previousNormalizedProps = newProps

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
						},
					)

					const initData = await initDataPromise
					that._pendingSetups.delete(moduleId)
					_pendingResolve()
					that.applyInitialData(moduleId, data, initData)
					return templateData
				},
				render(...args) {
					return markComponentHost(module.moduleInfo.render.apply(this, args), styleIsolation, id)
				},
			}
			componentCache.set(cacheKey, componentOptions)
			componentOptions.components = this.createComponent(
				resolvedComponentPath,
				bridgeId,
				subUsing,
				componentCache,
				subPlaceholder,
			)
			components[`dd-${componentName}`] = componentOptions
		}
		return components
	}

	updateModule(opts) {
		const { moduleId, data, changes = [] } = opts
		const setupData = this.setupData.get(moduleId)

		if (setupData) {
			let hasNewReactiveKey = false
			const newKeys = {}

			if (!this.initializedModules.has(moduleId)) {
				const pendingUpdate = this.preInitUpdates.get(moduleId) || { data: {}, changes: [] }
				Object.assign(pendingUpdate.data, data)
				pendingUpdate.changes.push(...changes)
				this.preInitUpdates.set(moduleId, pendingUpdate)
			}
			if (changes.length === 0) {
				for (const key in data) {
					if (!Object.prototype.hasOwnProperty.call(setupData, key)) {
						hasNewReactiveKey = true
						newKeys[key] = data[key]
					}
					set(setupData, key, data[key])
				}
			}
			for (const change of changes) {
				const rootKey = change.path[0]
				if (!Object.prototype.hasOwnProperty.call(setupData, rootKey)) {
					hasNewReactiveKey = true
				}
				set(setupData, change.path, change.value)
				newKeys[rootKey] = setupData[rootKey]
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

	getCanvasNodeId(canvas) {
		if (!canvas.__diminaCanvasNodeId) {
			Object.defineProperty(canvas, '__diminaCanvasNodeId', {
				value: `canvas_${uuid()}`,
				configurable: true,
			})
		}
		return canvas.__diminaCanvasNodeId
	}

	getCanvasCapabilities() {
		if (!this.canvasCapabilities) {
			this.canvasCapabilities = probeWebGLCapabilities()
		}
		return this.canvasCapabilities
	}

	publishCanvasCapabilities(bridgeId) {
		message.send({
			type: 'canvasCapabilities',
			target: 'service',
			body: {
				bridgeId,
				capabilities: this.getCanvasCapabilities(),
			},
		})
	}

	registerCanvasNode(canvas, type = canvas.getAttribute?.('type') || '2d') {
		const nodeId = this.getCanvasNodeId(canvas)
		const isNewNode = !this.canvasNodes.has(nodeId)
		const rect = canvas.getBoundingClientRect?.()
		const width = Math.round(rect?.width || 0)
		const height = Math.round(rect?.height || 0)
		if (isNewNode && width > 0 && height > 0) {
			if (canvas.width !== width) {
				canvas.width = width
			}
			if (canvas.height !== height) {
				canvas.height = height
			}
		}

		if (isNewNode) {
			this.canvasNodes.set(nodeId, {
				canvas,
				contexts: new Map(),
			})
		}
		return {
			__diminaNodeType: CANVAS_NODE_TYPE,
			nodeId,
			type,
			width: canvas.width || width || 300,
			height: canvas.height || height || 150,
			webglCapabilities: this.getCanvasCapabilities(),
		}
	}

	createOffscreenCanvas({ bridgeId, params }) {
		const { nodeId, width = 300, height = 150, type = '2d' } = params
		const canvas = document.createElement('canvas')
		canvas.width = width
		canvas.height = height
		this.canvasNodes.set(nodeId, {
			canvas,
			type,
			contexts: new Map(),
		})
		if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
			this.publishCanvasCapabilities(bridgeId)
		}
	}

	resolveCanvasArg(value) {
		if (value === null || value === undefined) {
			return value
		}

		if (Array.isArray(value)) {
			return value.map(item => this.resolveCanvasArg(item))
		}

		if (typeof value !== 'object') {
			return value
		}

		if (value.__canvasResourceId) {
			return this.canvasResources.get(value.__canvasResourceId)
		}

		if (value.__canvasNodeId) {
			return this.canvasNodes.get(value.__canvasNodeId)?.canvas
		}

		if (value.__canvasTypedArray) {
			const Ctor = TYPED_ARRAY_CTORS[value.__canvasTypedArray]
			if (Ctor) {
				return new Ctor(value.data || [])
			}
			if (value.__canvasTypedArray === 'DataView') {
				return new DataView(new Uint8Array(value.data || []).buffer)
			}
		}

		if (value.__canvasArrayBuffer) {
			return new Uint8Array(value.data || []).buffer
		}

		const result = {}
		for (const [key, item] of Object.entries(value)) {
			result[key] = this.resolveCanvasArg(item)
		}
		return result
	}

	getCanvasResource(id) {
		return this.canvasResources.get(id)
	}

	getCanvasResourceId(value) {
		if (value === null || value === undefined) {
			return null
		}
		for (const [id, resource] of this.canvasResources) {
			if (resource === value) {
				return id
			}
		}
		return null
	}

	setCanvasResource(id, value) {
		if (id) {
			this.canvasResources.set(id, value)
		}
	}

	getCanvasImage(imageId) {
		let image = this.getCanvasResource(imageId)
		if (!image) {
			image = new Image()
			image.crossOrigin = "anonymous";
			this.setCanvasResource(imageId, image)
		}
		return image
	}

	executeCanvasOperation(node, operation, bridgeId) {
		switch (operation.op) {
			case 'setCanvasProperty':
				node.canvas[operation.prop] = operation.value
				break
			case 'getContext': {
				let context = null
				let statusMessage
				try {
					context = node.canvas.getContext(
						operation.contextType,
						this.resolveCanvasArg(operation.attributes),
					)
				}
				catch (error) {
					statusMessage = error instanceof Error ? error.message : String(error)
				}
				node.contexts.set(operation.contextId, context)
				this.setCanvasResource(operation.contextId, context)
				const isWebGL = operation.contextType === 'webgl'
					|| operation.contextType === 'experimental-webgl'
					|| operation.contextType === 'webgl2'
				return {
					contextId: operation.contextId,
					context: context
						? {
							success: true,
							capabilities: isWebGL ? describeWebGLContext(context, false) : null,
						}
						: {
							success: false,
							statusMessage: statusMessage || `getContext(${operation.contextType}) returned null`,
						},
				}
			}
			case 'contextSetProperty': {
				const context = this.getCanvasResource(operation.contextId)
				if (context) {
					try {
						context[operation.prop] = this.resolveCanvasArg(operation.value)
					}
					catch (error) {
						console.warn('[system]', '[render]', `Canvas context property ${operation.prop} failed: ${error}`)
					}
				}
				break
			}
			case 'contextCall': {
				const context = this.getCanvasResource(operation.contextId)
				const method = context?.[operation.method]
				if (typeof method !== 'function') {
					break
				}
				const args = (operation.args || []).map(arg => this.resolveCanvasArg(arg))
				try {
					const result = method.apply(context, args)
					this.setCanvasResource(operation.resultId, result)
				}
				catch (error) {
					console.warn('[system]', '[render]', `Canvas context call ${operation.method} failed: ${error}`)
				}

				const feedback = {
					contextId: operation.contextId,
				}
				if (operation.feedback === 'shader') {
					const shader = args[0]
					let metadata = { compileStatus: false, infoLog: '' }
					try {
						metadata = {
							shaderType: context.getShaderParameter(shader, context.SHADER_TYPE),
							compileStatus: context.getShaderParameter(shader, context.COMPILE_STATUS),
							infoLog: context.getShaderInfoLog(shader) || '',
						}
					}
					catch {
						// Resource creation can legitimately fail and return null.
					}
					feedback.resource = {
						resourceId: operation.args?.[0]?.__canvasResourceId,
						metadata,
					}
				}
				else if (operation.feedback === 'program') {
					const program = args[0]
					let metadata = { linkStatus: false, validateStatus: false, infoLog: '' }
					try {
						metadata = {
							linkStatus: context.getProgramParameter(program, context.LINK_STATUS),
							validateStatus: context.getProgramParameter(program, context.VALIDATE_STATUS),
							infoLog: context.getProgramInfoLog(program) || '',
						}
					}
					catch {
						// Resource creation can legitimately fail and return null.
					}
					feedback.resource = {
						resourceId: operation.args?.[0]?.__canvasResourceId,
						metadata,
					}
				}
				if (operation.typedArrayUpdateId && Number.isInteger(operation.typedArrayArgIndex)) {
					feedback.typedArray = {
						id: operation.typedArrayUpdateId,
						value: serializeCanvasResult(args[operation.typedArrayArgIndex]),
					}
				}
				return feedback
			}
			case 'contextQuery': {
				const context = this.getCanvasResource(operation.contextId)
				const method = context?.[operation.method]
				if (typeof method !== 'function') {
					break
				}
				let value = null
				try {
					value = method.apply(context, (operation.args || []).map(arg => this.resolveCanvasArg(arg)))
				}
				catch (error) {
					console.warn('[system]', '[render]', `Canvas context query ${operation.method} failed: ${error}`)
				}
				return {
					contextId: operation.contextId,
					query: {
						key: operation.key,
						value: serializeCanvasResult(value, item => this.getCanvasResourceId(item)),
					},
				}
			}
			case 'contextFeedback':
				break
			case 'getExtension': {
				const context = this.getCanvasResource(operation.contextId)
				let extension = null
				try {
					extension = context?.getExtension?.(operation.name) || null
				}
				catch (error) {
					console.warn('[system]', '[render]', `Canvas extension ${operation.name} failed: ${error}`)
				}
				this.setCanvasResource(operation.extensionId, extension)
				break
			}
			case 'extensionCall': {
				const extension = this.getCanvasResource(operation.extensionId)
				const method = extension?.[operation.method]
				if (typeof method === 'function') {
					try {
						const result = method.apply(extension, (operation.args || []).map(arg => this.resolveCanvasArg(arg)))
						this.setCanvasResource(operation.resultId, result)
					}
					catch (error) {
						console.warn('[system]', '[render]', `Canvas extension call ${operation.method} failed: ${error}`)
					}
				}
				break
			}
			case 'resourceCall': {
				const resource = this.getCanvasResource(operation.resourceId)
				const method = resource?.[operation.method]
				if (typeof method === 'function') {
					const result = method.apply(resource, (operation.args || []).map(arg => this.resolveCanvasArg(arg)))
					this.setCanvasResource(operation.resultId, result)
				}
				break
			}
			case 'createImage':
				this.getCanvasImage(operation.imageId)
				break
			case 'imageSetSrc': {
				const image = this.getCanvasImage(operation.imageId)
				image.onload = () => {
					this.triggerCallback(bridgeId, operation.onload, {
						width: image.width,
						height: image.height,
					})
				}
				image.onerror = () => {
					this.triggerCallback(bridgeId, operation.onerror, {
						errMsg: `createImage:fail ${operation.src}`,
					})
				}
				image.src = operation.src
				break
			}
			case 'getImageData': {
				const context = this.getCanvasResource(operation.contextId)
				if (context) {
					const imageData = context.getImageData(operation.x, operation.y, operation.width, operation.height)
					this.triggerCallback(bridgeId, operation.callback, {
						data: Array.from(imageData.data),
						width: imageData.width,
						height: imageData.height,
					})
				}
				break
			}
			case 'toDataURL': {
				const mimeType = operation.mimeType || 'image/png'
				const dataURL = operation.quality !== undefined
					? node.canvas.toDataURL(mimeType, operation.quality)
					: node.canvas.toDataURL(mimeType)
				this.triggerCallback(bridgeId, operation.callback, dataURL)
				break
			}
			default:
				console.warn('[system]', '[render]', `Unsupported canvas node operation: ${operation.op}`)
		}
	}

	canvasNodeFlush({ bridgeId, params }) {
		const node = this.canvasNodes.get(params.nodeId)
		if (!node) {
			console.warn('[system]', '[render]', `canvas node ${params.nodeId} not found`)
			this.triggerCallback(bridgeId, params.feedback, {})
			return
		}

		const feedback = {
			contexts: {},
			typedArrays: [],
		}
		const touchedContexts = new Set()
		for (const operation of params.operations || []) {
			if (operation.contextId) {
				touchedContexts.add(operation.contextId)
			}
			const result = this.executeCanvasOperation(node, operation, bridgeId)
			if (!result) {
				continue
			}
			if (result.contextId) {
				feedback.contexts[result.contextId] ||= {}
				if (result.context) {
					Object.assign(feedback.contexts[result.contextId], result.context)
				}
				if (result.resource?.resourceId) {
					feedback.contexts[result.contextId].resources ||= []
					feedback.contexts[result.contextId].resources.push(result.resource)
				}
				if (result.query) {
					feedback.contexts[result.contextId].queries ||= []
					feedback.contexts[result.contextId].queries.push(result.query)
				}
			}
			if (result.typedArray) {
				feedback.typedArrays.push(result.typedArray)
			}
		}

		for (const contextId of params.feedback ? touchedContexts : []) {
			const context = this.getCanvasResource(contextId)
			if (!context || typeof context.getError !== 'function') {
				continue
			}
			feedback.contexts[contextId] ||= {}
			feedback.contexts[contextId].contextLost = Boolean(context.isContextLost?.())
			const errors = []
			for (let i = 0; i < 32; i++) {
				const error = context.getError()
				if (error === context.NO_ERROR) {
					break
				}
				errors.push(error)
			}
			if (errors.length > 0) {
				feedback.contexts[contextId].errors = errors
			}
		}
		this.triggerCallback(bridgeId, params.feedback, feedback)
	}

	canvasNodeRequestAnimationFrame({ bridgeId, params }) {
		const key = `${params.nodeId}:${params.requestId}`
		const frameId = requestAnimationFrame((timestamp) => {
			this.canvasRafIds.delete(key)
			this.triggerCallback(bridgeId, params.callback, timestamp)
		})
		this.canvasRafIds.set(key, frameId)
	}

	canvasNodeCancelAnimationFrame({ params }) {
		const key = `${params.nodeId}:${params.requestId}`
		const frameId = this.canvasRafIds.get(key)
		if (frameId !== undefined) {
			cancelAnimationFrame(frameId)
			this.canvasRafIds.delete(key)
		}
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

	videoContext(opts) {
		message.event.emit('videoContext', opts.params)
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

		if (fields.node) {
			data.node = isCanvasElement(targetElement)
				? this.registerCanvasNode(targetElement)
				: null
		}
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
            const exportWidth = width || canvas.width;
            const exportHeight = height || canvas.height;
            const outputCanvas = document.createElement("canvas");
            outputCanvas.width = destWidth || exportWidth;
            outputCanvas.height = destHeight || exportHeight;
            const outputContext = outputCanvas.getContext("2d");
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
            );

            const mimeType =
                fileType === "jpg" || fileType === "jpeg"
                    ? "image/jpeg"
                    : "image/png";
            const dataURL = outputCanvas.toDataURL(mimeType, quality);

            // TODO: 添加一个 H5 的容器标识在 userAgent
            // const byteString = atob(dataURL.split(",")[1]);
            // const ab = new ArrayBuffer(byteString.length);
            // const ia = new Uint8Array(ab);
            // for (let i = 0; i < byteString.length; i++) {
            //     ia[i] = byteString.charCodeAt(i);
            // }
            // const blob = new Blob([ab], { type: mimeType });
            // const tempFilePath = URL.createObjectURL(blob);

            // const result = {
            //     tempFilePath,
            //     errMsg: "canvasToTempFilePath:ok",
            // };
            // this.triggerCallback(
            //     bridgeId,
            //     params.success,
            //     [result],
            //     result,
            // );
            // this.triggerCallback(
            //     bridgeId,
            //     params.complete,
            //     [result],
            //     result,
            // );

            // Forward to Container to write base64 to a temp file and return a real file path
            message.invoke({
                type: "invokeAPI",
                target: "container",
                body: {
                    name: "saveCanvasTempFile",
                    bridgeId,
                    params: {
                        dataURL,
                        fileType,
                        success: params.success,
                        fail: params.fail,
                        complete: params.complete,
                    },
                },
            });
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

			// 目标 DOM 已出现，等待所有 pending setup 完成（service 侧 created 与初始数据握手完毕），
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

	addMediaQueryObserver({ bridgeId, params }) {
		const { condition = {}, success } = params
		const mediaFeatures = {
			minWidth: 'min-width',
			maxWidth: 'max-width',
			width: 'width',
			minHeight: 'min-height',
			maxHeight: 'max-height',
			height: 'height',
		}
		const clauses = []
		for (const [key, feature] of Object.entries(mediaFeatures)) {
			if (Number.isFinite(condition[key]) && condition[key] >= 0) {
				clauses.push(`(${feature}: ${condition[key]}px)`)
			}
		}
		if (condition.orientation) {
			clauses.push(`(orientation: ${condition.orientation})`)
		}

		const mediaQueryList = window.matchMedia(clauses.join(' and ') || 'all')
		const observerId = uuid()
		const listener = event => this.triggerCallback(bridgeId, success, {
			observerId,
			matches: event.matches,
		})
		if (mediaQueryList.addEventListener) {
			mediaQueryList.addEventListener('change', listener)
		}
		else {
			mediaQueryList.addListener?.(listener)
		}
		this.mediaQueryObservers.set(observerId, { mediaQueryList, listener })
		this.triggerCallback(bridgeId, success, {
			observerId,
			matches: mediaQueryList.matches,
		})
	}

	removeMediaQueryObserver({ params: { observerId } }) {
		const observer = this.mediaQueryObservers.get(observerId)
		if (!observer) {
			return
		}
		if (observer.mediaQueryList.removeEventListener) {
			observer.mediaQueryList.removeEventListener('change', observer.listener)
		}
		else {
			observer.mediaQueryList.removeListener?.(observer.listener)
		}
		this.mediaQueryObservers.delete(observerId)
	}

	async componentAnimate({ bridgeId, params }) {
		const { moduleId, selector, keyframes = [], duration = 0, success } = params
		const root = await this.waitForEl(this.instance.get(moduleId))
		const elements = root?.querySelectorAll?.(selector) || []
		const animationKey = `${moduleId}:${selector}`
		const previousAnimations = this.componentAnimations.get(animationKey)
		previousAnimations?.forEach(animation => animation.cancel())

		const normalizedKeyframes = Array.from(keyframes, (keyframe) => {
			const normalized = { ...keyframe }
			if (normalized.ease && !normalized.easing) {
				normalized.easing = normalized.ease
				delete normalized.ease
			}
			return normalized
		})
		const animations = Array.from(elements, element => element.animate(normalizedKeyframes, {
			duration: Math.max(Number(duration) || 0, 0),
			fill: 'forwards',
		}))
		const animationSet = new Set(animations)
		this.componentAnimations.set(animationKey, animationSet)
		await Promise.allSettled(animations.map(animation => animation.finished))
		if (this.componentAnimations.get(animationKey) === animationSet) {
			this.componentAnimations.delete(animationKey)
		}
		this.triggerCallback(bridgeId, success)
	}

	async componentClearAnimation({ bridgeId, params }) {
		const { moduleId, selector, options = {}, success } = params
		const animationKey = `${moduleId}:${selector}`
		const animations = this.componentAnimations.get(animationKey) || []
		for (const animation of animations) {
			if (options.final) {
				try {
					animation.finish()
					animation.commitStyles?.()
				}
				catch {
					// An idle or scroll-driven animation cannot always be finished.
				}
			}
			animation.cancel()
		}
		this.componentAnimations.delete(animationKey)
		this.triggerCallback(bridgeId, success)
	}

	addPerformanceObserver({ bridgeId, params }) {
		const { entryTypes = [], success } = params
		const observerId = uuid()
		if (typeof PerformanceObserver === 'undefined') {
			this.triggerCallback(bridgeId, success, { observerId, unsupported: true })
			return
		}

		const supportedTypes = new Set(PerformanceObserver.supportedEntryTypes || [])
		const normalizedTypes = entryTypes.filter(type => supportedTypes.size === 0 || supportedTypes.has(type))
		const observer = new PerformanceObserver((list) => {
			const entries = list.getEntries().map(entry => (
				typeof entry.toJSON === 'function'
					? entry.toJSON()
					: {
						name: entry.name,
						entryType: entry.entryType,
						startTime: entry.startTime,
						duration: entry.duration,
					}
			))
			this.triggerCallback(bridgeId, success, {
				observerId,
				data: { entryList: JSON.stringify(entries) },
			})
		})
		if (normalizedTypes.length > 0) {
			observer.observe({ entryTypes: normalizedTypes })
		}
		this.performanceObservers.set(observerId, observer)
		this.triggerCallback(bridgeId, success, { observerId })
	}

	removePerformanceObserver({ params: { observerId } }) {
		const observer = this.performanceObservers.get(observerId)
		observer?.disconnect()
		this.performanceObservers.delete(observerId)
	}
}

export default new Runtime()
