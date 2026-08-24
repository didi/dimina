import { CANVAS_ACTIVE_PROP, CANVAS_CONTRACT_CHANGE_EVENT, CANVAS_NODE_PROP, CANVAS_OWNER_PROP, canvasPixelBudgetError, deepEqual, getDataAttributes, normalizePropertyValues as normalizeMiniProgramPropertyValues, set, uuid } from '@dimina/common'
import { Components, deepToRaw } from '@dimina/components'
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
import { resolveCanvasExportSize } from './canvas-export-limits'
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

function installPageFrameStyleScopes(scopeIds) {
	const pageFrame = document.body?.classList.contains('dd-page') ? document.body : null
	if (!pageFrame) {
		return () => {}
	}

	const addedScopeIds = [...new Set(scopeIds.filter(Boolean))]
		.filter((scopeId) => {
			if (pageFrame.hasAttribute(scopeId)) {
				return false
			}
			pageFrame.setAttribute(scopeId, '')
			return true
		})

	return () => {
		for (const scopeId of addedScopeIds) {
			pageFrame.removeAttribute(scopeId)
		}
	}
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

// Path snapshots only accept path-construction methods. Keeping this allowlist
// separate prevents malformed bridge data from invoking arbitrary context methods.
const CANVAS_PATH_STEP_METHOD_NAMES = [
	'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'arcTo',
	'quadraticCurveTo', 'bezierCurveTo',
]
const CANVAS_PATH_STEP_METHODS = new Set(CANVAS_PATH_STEP_METHOD_NAMES)

const CANVAS_DIRECT_METHODS = new Set([
	'beginPath', ...CANVAS_PATH_STEP_METHOD_NAMES,
	'clearRect', 'fillRect', 'strokeRect',
	'fillText', 'strokeText',
	'save', 'restore',
	'translate', 'rotate', 'scale', 'transform', 'setTransform',
])

// 只是给 context 上某个属性赋值的 action
const CANVAS_PROPERTY_ACTIONS = {
	setGlobalAlpha: 'globalAlpha',
	setLineCap: 'lineCap',
	setLineJoin: 'lineJoin',
	setLineWidth: 'lineWidth',
	setMiterLimit: 'miterLimit',
	setTextAlign: 'textAlign',
	setGlobalCompositeOperation: 'globalCompositeOperation',
	setLineDashOffset: 'lineDashOffset',
	setShadowBlur: 'shadowBlur',
	setShadowColor: 'shadowColor',
	setShadowOffsetX: 'shadowOffsetX',
	setShadowOffsetY: 'shadowOffsetY',
}

const CANVAS_FONT_SIZE_PATTERN = /\d+\.?\d*px/

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

function readCanvas2DState(context, stateSequences = {}) {
	const state = []
	for (const [prop, sequence] of Object.entries(stateSequences)) {
		let value
		try {
			value = context[prop]
		}
		catch {
			continue
		}
		if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
			state.push({ prop, sequence, value })
		}
	}
	return state
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

function resolveCanvasNodeElement(element) {
	if (isCanvasElement(element)) {
		return element
	}
	const canvas = element?.[CANVAS_NODE_PROP]
	// DOM contract 必须仍指向这个宿主里的真实 canvas；卸载或错误复用后的陈旧引用不能登记。
	return isCanvasElement(canvas) && element.contains?.(canvas) ? canvas : null
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
		// 队列和回放状态都按真实 canvas 元素隔离；canvas-id 只在组件作用域内唯一。
		// WeakMap 让卸载后的画布及其队列、save/clip 状态可以一起回收。
		this.canvasDrawQueues = new WeakMap()
		// 每块画布当前批次的基线 save 帧，draw(reserve) 靠它在不动像素的前提下回到默认绘图状态。
		this.canvasBatchFrames = new WeakMap()
		// DOM 解析本身也可能异步等待节点。按页面/组件作用域先排住「解析 + 操作」，否则先发的
		// 请求还在等 MutationObserver 时，后发请求可能先找到节点并越过它执行。
		this.canvasScopeQueues = new Map()
		this.canvasImageTimeout = 10000
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
		for (const nodeId of [...this.canvasNodes.keys()]) this.disposeCanvasNode(nodeId)
		for (const frameId of this.canvasRafIds.values()) {
			cancelAnimationFrame(frameId)
		}
		this.canvasRafIds.clear()
		this.canvasScopeQueues.clear()
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
							let clearPageFrameStyleScopes = () => {}

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
								clearPageFrameStyleScopes = installPageFrameStyleScopes(globalStyleScopeIds)
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
								clearPageFrameStyleScopes()
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

					// 这里只把宿主节点的事件绑定登记给逻辑层；派发由 ComponentHost 的 useTouchEvents
					// 负责，tap 和普通组件一样由触摸序列合成，catch 才能通过共享的停止标记切断祖先。
					// 用原生 click 在这里派发的话，tap 会排在祖先的合成 tap 之后，后代 catchtap 拦不住祖先。
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
		const layoutError = canvasPixelBudgetError(width, height, { allowZero: true })
		if (isNewNode && !layoutError && width > 0 && height > 0) {
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
				resourceIds: new Set(),
			})
		}
		return {
			__diminaNodeType: CANVAS_NODE_TYPE,
			nodeId,
			type,
			width: canvas.width ?? (!layoutError && width > 0 ? width : 300),
			height: canvas.height ?? (!layoutError && height > 0 ? height : 150),
			webglCapabilities: this.getCanvasCapabilities(),
		}
	}

	createOffscreenCanvas({ bridgeId, params }) {
		const { nodeId, width = 300, height = 150, type = '2d' } = params
		// 超预算的尺寸只能来自不做前置检查的旧版基础库。抛出去会变成 webview 的未捕获异常，
		// 而这条链上其余入口都把失败收敛成告警；节点不创建，后续操作走 not-found 兜底。
		const budgetError = canvasPixelBudgetError(width, height, { allowZero: true })
		if (budgetError) {
			console.warn('[system]', '[render]', `createOffscreenCanvas ${nodeId} rejected: ${budgetError}`)
			return
		}
		const canvas = document.createElement('canvas')
		canvas.width = width
		canvas.height = height
		this.canvasNodes.set(nodeId, {
			canvas,
			type,
			contexts: new Map(),
			resourceIds: new Set(),
			bridgeId,
		})
		if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
			this.publishCanvasCapabilities(bridgeId)
		}
	}

	createGameCanvas({ bridgeId, params }) {
		const { nodeId, width = 300, height = 150, type = '2d' } = params
		const budgetError = canvasPixelBudgetError(width, height, { allowZero: true })
		if (budgetError) {
			console.warn('[system]', '[render]', `createGameCanvas ${nodeId} rejected: ${budgetError}`)
			return
		}
		const existing = this.canvasNodes.get(nodeId)
		if (existing) {
			return
		}

		const canvas = document.createElement('canvas')
		canvas.width = width
		canvas.height = height
		canvas.setAttribute('data-dimina-game-canvas', '')
		Object.assign(canvas.style, {
			display: 'block',
			position: 'fixed',
			inset: '0',
			width: '100%',
			height: '100%',
			touchAction: 'none',
		})

		const serializeTouch = (touch) => ({
			identifier: touch.identifier,
			clientX: touch.clientX,
			clientY: touch.clientY,
			pageX: touch.pageX,
			pageY: touch.pageY,
			force: Number.isFinite(touch.force) ? touch.force : 0,
		})
		const handlers = new Map()
		const sendGameTouch = (eventType, touches, changedTouches, timeStamp) => {
			message.send({
				type: 'gameTouch',
				target: 'service',
				body: {
					bridgeId,
					eventType,
					touches,
					changedTouches,
					timeStamp,
				},
			})
		}
		for (const eventType of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
			const handler = (event) => {
				if (event.cancelable) {
					event.preventDefault()
				}
				sendGameTouch(
					eventType,
					Array.from(event.touches || [], serializeTouch),
					Array.from(event.changedTouches || [], serializeTouch),
					event.timeStamp,
				)
			}
			handlers.set(eventType, handler)
			canvas.addEventListener(eventType, handler, { passive: false })
		}

		// 微信开发者工具会把模拟器里的鼠标操作转换成小游戏触摸事件。
		// Web 容器做同样的兼容。触摸处理器已经 preventDefault，因此移动端
		// 不会再派发兼容 mouse 事件，也就不会产生一触双发。
		let mouseActive = false
		let mouseHoverEnabled = false
		const mouseEventTypes = {
			mousedown: 'touchstart',
			mousemove: 'touchmove',
			mouseup: 'touchend',
			mouseleave: 'touchcancel',
		}
		for (const [mouseType, touchType] of Object.entries(mouseEventTypes)) {
			const handler = (event) => {
				if (mouseType === 'mousedown') {
					if (event.button !== 0) return
					mouseActive = true
					mouseHoverEnabled = true
				}
				else if (mouseType === 'mousemove' && !mouseHoverEnabled) {
					return
				}
				else if (mouseType !== 'mousemove' && !mouseActive) {
					return
				}

				if (event.cancelable) event.preventDefault()
				const touch = serializeTouch({
					identifier: 0,
					clientX: event.clientX,
					clientY: event.clientY,
					pageX: event.pageX,
					pageY: event.pageY,
					force: mouseActive ? 0.5 : 0,
				})
				const ended = touchType === 'touchend' || touchType === 'touchcancel'
				sendGameTouch(touchType, ended ? [] : [touch], [touch], event.timeStamp)
				if (ended) mouseActive = false
			}
			handlers.set(mouseType, handler)
			canvas.addEventListener(mouseType, handler, { passive: false })
		}

		document.body.append(canvas)
		this.canvasNodes.set(nodeId, {
			canvas,
			type,
			contexts: new Map(),
			resourceIds: new Set(),
			bridgeId,
			cleanup: () => {
				for (const [eventType, handler] of handlers) {
					canvas.removeEventListener(eventType, handler)
				}
				canvas.remove()
			},
		})
		this.publishCanvasCapabilities(bridgeId)
	}

	disposeCanvasNode(nodeId, bridgeId) {
		const node = this.canvasNodes.get(nodeId)
		if (!node || (node.bridgeId && bridgeId && node.bridgeId !== bridgeId)) return
		node.cleanup?.()
		for (const resourceId of node.resourceIds || []) {
			const resource = this.canvasResources.get(resourceId)
			if (resource && (typeof resource === 'object' || typeof resource === 'function')) {
				if ('onload' in resource) resource.onload = null
				if ('onerror' in resource) resource.onerror = null
			}
			this.canvasResources.delete(resourceId)
		}
		for (const contextId of node.contexts?.keys() || []) this.canvasResources.delete(contextId)
		for (const [key, frameId] of [...this.canvasRafIds]) {
			if (!key.startsWith(`${nodeId}:`)) continue
			cancelAnimationFrame(frameId)
			this.canvasRafIds.delete(key)
		}
		this.canvasNodes.delete(nodeId)
	}

	disposeCanvasNodes({ bridgeId, params }) {
		for (const nodeId of new Set(params.nodeIds || [])) this.disposeCanvasNode(nodeId, bridgeId)
	}

	resolveCanvasArg(value, context) {
		if (value === null || value === undefined) {
			return value
		}

		if (Array.isArray(value)) {
			return value.map(item => this.resolveCanvasArg(item, context))
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

		if (value.__canvasImageData) {
			const budgetError = canvasPixelBudgetError(value.width, value.height, { transferable: true })
			if (budgetError) throw new RangeError(budgetError)
			const imageData = context?.createImageData?.(value.width, value.height)
			if (!imageData?.data) throw new TypeError('target context cannot create ImageData')
			if (imageData.data.length !== value.data?.length) {
				throw new RangeError('ImageData data length does not match its dimensions')
			}
			imageData.data.set(value.data)
			return imageData
		}

		const result = {}
		for (const [key, item] of Object.entries(value)) {
			result[key] = this.resolveCanvasArg(item, context)
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

	setCanvasResource(id, value, node) {
		if (id) {
			this.canvasResources.set(id, value)
			node?.resourceIds?.add(id)
		}
	}

	getCanvasImage(imageId, node) {
		let image = this.getCanvasResource(imageId)
		if (!image) {
			image = new Image()
			image.crossOrigin = "anonymous";
			this.setCanvasResource(imageId, image, node)
		}
		return image
	}

	executeCanvasOperation(node, operation, bridgeId) {
		switch (operation.op) {
			case 'setCanvasProperty': {
				if (operation.prop === 'width' || operation.prop === 'height') {
					const width = operation.prop === 'width' ? operation.value : node.canvas.width
					const height = operation.prop === 'height' ? operation.value : node.canvas.height
					const budgetError = canvasPixelBudgetError(width, height, { allowZero: true })
					if (budgetError) throw new RangeError(budgetError)
				}
				node.canvas[operation.prop] = operation.value
				break
			}
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
				this.setCanvasResource(operation.contextId, context, node)
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
					const supported = operation.prop in context
					if (supported) {
						try {
							context[operation.prop] = this.resolveCanvasArg(operation.value)
						}
						catch (error) {
							console.warn('[system]', '[render]', `Canvas context property ${operation.prop} failed: ${error}`)
						}
					}
					if (operation.feedback === 'state') {
						let value
						try {
							value = supported
								? context[operation.prop]
								: this.resolveCanvasArg(operation.previousValue)
						}
						catch {
							break
						}
						if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
							return {
								contextId: operation.contextId,
								state: {
									prop: operation.prop,
									sequence: operation.sequence,
									value,
								},
							}
						}
					}
				}
				break
			}
			case 'contextCall': {
				const context = this.getCanvasResource(operation.contextId)
				const method = context?.[operation.method]
				const resetFallback = operation.method === 'reset' && context && typeof method !== 'function'
				if (typeof method !== 'function' && !resetFallback) {
					break
				}
				const args = (operation.args || []).map(arg => this.resolveCanvasArg(arg, context))
				// 兼容 active ImageData wire contract 之前发布的基础库：旧 service 会把 ImageData
				// 序列化成普通 {width,height,data}，新 render 在真正调用前补回浏览器对象。
				if (operation.method === 'putImageData' && args[0]?.data instanceof Uint8ClampedArray
					&& Object.prototype.toString.call(args[0]) !== '[object ImageData]') {
					const legacy = args[0]
					const budgetError = canvasPixelBudgetError(legacy.width, legacy.height, { transferable: true })
					if (budgetError) throw new RangeError(budgetError)
					const imageData = context.createImageData(legacy.width, legacy.height)
					if (imageData.data.length !== legacy.data.length) {
						throw new RangeError('ImageData data length does not match its dimensions')
					}
					imageData.data.set(legacy.data)
					args[0] = imageData
				}
				try {
					if (resetFallback) {
						// 老 WebKit 没有 CanvasRenderingContext2D.reset()；重设相同 backing width
						// 是 HTML Canvas 规范提供的等价全状态/像素/路径/clip 重置入口。
						const backingWidth = node.canvas.width
						node.canvas.width = backingWidth
					}
					else {
						const result = method.apply(context, args)
						this.setCanvasResource(operation.resultId, result, node)
					}
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
				if (operation.feedback === 'stateSnapshot') {
					feedback.state = readCanvas2DState(context, operation.stateSequences)
				}
				return feedback
			}
			case 'contextStateSnapshot': {
				const context = this.getCanvasResource(operation.contextId)
				if (!context) break
				return {
					contextId: operation.contextId,
					state: readCanvas2DState(context, operation.stateSequences),
				}
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
				this.setCanvasResource(operation.extensionId, extension, node)
				break
			}
			case 'extensionCall': {
				const extension = this.getCanvasResource(operation.extensionId)
				const method = extension?.[operation.method]
				if (typeof method === 'function') {
					try {
						const result = method.apply(extension, (operation.args || []).map(arg => this.resolveCanvasArg(arg)))
						this.setCanvasResource(operation.resultId, result, node)
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
					this.setCanvasResource(operation.resultId, result, node)
				}
				break
			}
			case 'createImage':
				this.getCanvasImage(operation.imageId, node)
				break
			case 'imageSetSrc': {
				const image = this.getCanvasImage(operation.imageId, node)
				const settle = (outcome) => {
					image.onload = null
					image.onerror = null
					if (operation.callback) {
						this.triggerCallback(bridgeId, operation.callback, outcome)
					}
					else {
						const callbackId = outcome.ok ? operation.onload : operation.onerror
						this.triggerCallback(bridgeId, callbackId, outcome.value)
					}
				}
				image.onload = () => {
					settle({ ok: true, value: { width: image.width, height: image.height } })
				}
				image.onerror = () => {
					settle({ ok: false, value: { errMsg: `createImage:fail ${operation.src}` } })
				}
				image.src = operation.src
				break
			}
			case 'getImageData': {
				const context = this.getCanvasResource(operation.contextId)
				if (context) {
					const budgetError = canvasPixelBudgetError(operation.width, operation.height, { transferable: true })
					if (budgetError) throw new RangeError(budgetError)
					const imageData = context.getImageData(operation.x, operation.y, operation.width, operation.height)
					const value = operation.resultEnvelope
						? {
							__canvasImageData: true,
							data: Array.from(imageData.data),
							width: imageData.width,
							height: imageData.height,
						}
						: {
							data: Array.from(imageData.data),
							width: imageData.width,
							height: imageData.height,
						}
					this.triggerCallback(bridgeId, operation.callback,
						operation.resultEnvelope ? { ok: true, value } : value)
				}
				break
			}
			case 'toDataURL': {
				const mimeType = operation.mimeType || 'image/png'
				const dataURL = operation.quality !== undefined
					? node.canvas.toDataURL(mimeType, operation.quality)
					: node.canvas.toDataURL(mimeType)
				this.triggerCallback(bridgeId, operation.callback,
					operation.resultEnvelope ? { ok: true, value: dataURL } : dataURL)
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
			for (const operation of params.operations || []) {
				this.triggerCallback(bridgeId, operation.callback,
					operation.resultEnvelope ? { ok: false, error: 'canvas node not found' } : undefined)
			}
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
			let result
			try {
				result = this.executeCanvasOperation(node, operation, bridgeId)
			}
			catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				console.warn('[system]', '[render]', `Canvas operation ${operation.op} failed: ${reason}`)
				this.triggerCallback(bridgeId, operation.callback,
					operation.resultEnvelope ? { ok: false, error: reason } : undefined)
				continue
			}
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
				if (result.state) {
					feedback.contexts[result.contextId].state ||= []
					feedback.contexts[result.contextId].state.push(...(Array.isArray(result.state) ? result.state : [result.state]))
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
			const canvas = resolveCanvasNodeElement(targetElement)
			data.node = canvas
				? this.registerCanvasNode(canvas)
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
		this.triggerCallback(bridgeId, params.fail, result, result)
		this.triggerCallback(bridgeId, params.complete, result, result)
	}

	async getCanvasElement(canvasId, moduleId, bridgeId) {
		// 逻辑层在未显式传组件时使用页面 bridgeId；页面根本身则登记在另一套 pageId 下。
		// bridgeId 明确代表当前页面作用域，可以直接落到 document.body，不能把它当成失效组件 id。
		const isPageScope = !moduleId || moduleId === bridgeId
		const scope = isPageScope ? document.body : await this.waitForEl(this.instance.get(moduleId))
		if (!scope?.querySelector) {
			return null
		}
		const owner = isPageScope ? this.pageId : moduleId
		const candidates = () => [
			...(scope.matches?.('canvas[canvas-id]') ? [scope] : []),
			...scope.querySelectorAll('canvas[canvas-id]'),
		]
			.filter(el => el.getAttribute('canvas-id') === String(canvasId) && !el.getAttribute('type'))
		const belongsToLegacyScope = (canvas) => {
			const componentHost = canvas.closest?.(`[${COMPONENT_HOST_ATTRIBUTE}]`)
			if (isPageScope) return componentHost === null
			return componentHost === null || componentHost === scope
		}
		const resolve = () => {
			const matches = candidates()
			const activeOwned = matches.find(el => el[CANVAS_OWNER_PROP] === owner
				&& el[CANVAS_ACTIVE_PROP] === true)
			if (activeOwned) return activeOwned

			// 兼容已经发布过 owner、但早于 active contract 的基础库。旧实现隐藏的 duplicate
			// 不得借兼容路径重新成为候选。
			const legacyOwned = matches.find(el => el[CANVAS_OWNER_PROP] === owner
				&& el[CANVAS_ACTIVE_PROP] === undefined
				&& el.closest?.('.dd-canvas')?.style.display !== 'none')
			if (legacyOwned) return legacyOwned

			return matches.find(el => el[CANVAS_OWNER_PROP] === undefined
				&& el[CANVAS_ACTIVE_PROP] === undefined
				&& belongsToLegacyScope(el)) || null
		}

		const resolved = resolve()
		if (resolved) return resolved
		return new Promise((done) => {
			const settle = () => {
				const canvas = resolve()
				if (!canvas) return false
				observer.disconnect()
				scope.removeEventListener(CANVAS_CONTRACT_CHANGE_EVENT, settle)
				done(canvas)
				return true
			}
			const observer = new MutationObserver(settle)
			observer.observe(scope, {
				attributes: true,
				attributeFilter: ['canvas-id', 'type'],
				childList: true,
				subtree: true,
			})
			scope.addEventListener(CANVAS_CONTRACT_CHANGE_EVENT, settle)
			setTimeout(() => {
				observer.disconnect()
				scope.removeEventListener(CANVAS_CONTRACT_CHANGE_EVENT, settle)
				done(null)
			}, 500)
		})
	}

	ensureCanvasResolution(canvas) {
		const rect = canvas.getBoundingClientRect()
		const width = Math.max(Math.round(rect.width), 1)
		const height = Math.max(Math.round(rect.height), 1)
		const layoutError = canvasPixelBudgetError(width, height)
		if (layoutError) throw new RangeError(layoutError)

		let resized = false
		if (canvas.width !== width) {
			canvas.width = width
			resized = true
		}
		if (canvas.height !== height) {
			canvas.height = height
			resized = true
		}
		return resized
	}

	loadCanvasImage(src) {
		return new Promise((resolve, reject) => {
			const image = new Image()
			let timer = null
			const settle = (done, value) => {
				if (timer !== null) {
					clearTimeout(timer)
					timer = null
				}
				image.onload = null
				image.onerror = null
				done(value)
			}
			image.crossOrigin = 'anonymous'
			image.onload = () => settle(resolve, image)
			image.onerror = () => settle(reject, new Error(`Failed to load image: ${src}`))
			// 服务器把连接 hold 住时 onload/onerror 都不会来，没有这道超时会堵死整块画布的回放队列
			timer = setTimeout(
				() => settle(reject, new Error(`Timed out loading image: ${src}`)),
				this.canvasImageTimeout,
			)
			image.src = src
		})
	}

	/**
	 * 单条 action 失败会终止整批并由 drawCanvas 走 fail/complete，与官方批级 try/catch 一致。
	 */
	async replayCanvasActions(context, actions = [], frame = null) {
		for (const action of actions) {
			const { type, args = [] } = action || {}
			await this.applyCanvasAction(context, type, args, frame)
		}
	}

	async applyCanvasAction(context, type, args, frame = null) {
		// save / restore 与批次基线帧共用一本账：批次开始时弹掉的正是这里压进去的帧。
		// 没有配平的 restore 必须停在批内，否则会连基线帧一起弹走，下一批就拿不到默认状态了
		// ——真实 canvas 对空栈 restore 本来也是空操作。
		if (frame && type === 'save') {
			context.save()
			frame.depth += 1
			return
		}
		if (frame && type === 'restore') {
			if (frame.depth === 0) {
				return
			}
			context.restore()
			frame.depth -= 1
			return
		}

		if (CANVAS_DIRECT_METHODS.has(type)) {
			context[type](...args)
			return
		}

		const property = CANVAS_PROPERTY_ACTIONS[type]
		if (property) {
			context[property] = args[0]
			return
		}

		switch (type) {
			case 'fillPath':
			case 'strokePath':
			case 'clip': {
				if (Array.isArray(args[0])) {
					this.replayCanvasPath(context, args[0])
				}
				context[type === 'fillPath' ? 'fill' : type === 'strokePath' ? 'stroke' : 'clip']()
				break
			}
			case 'fill':
			case 'stroke':
				context[type](...args)
				break
			case 'drawImage': {
				const [src, ...drawArgs] = args
				const image = await this.loadCanvasImage(src)
				context.drawImage(image, ...drawArgs)
				break
			}
			case 'setFillStyle':
			case 'setStrokeStyle': {
				const style = await this.resolveCanvasStyle(context, args[0])
				context[type === 'setFillStyle' ? 'fillStyle' : 'strokeStyle'] = style
				break
			}
			case 'setShadow':
				context.shadowOffsetX = args[0]
				context.shadowOffsetY = args[1]
				context.shadowBlur = args[2]
				context.shadowColor = args[3]
				break
			case 'setLineDash':
				context.setLineDash(args[0] || [])
				context.lineDashOffset = args[1] || 0
				break
			case 'setTextBaseline':
				// 'normal' 是微信文档列出的合法值，官方示例里也在用，但它不是 canvas 的合法枚举值——
				// 直接赋过去会被静默忽略、停在上一次的基线上。官方回放层就是这么映射的。
				context.textBaseline = args[0] === 'normal' ? 'alphabetic' : args[0]
				break
			case 'setFont':
				context.font = args[0]
				break
			case 'setFontSize':
				// 字号之外的字体分量只存在于 context.font 里，替换而不是重拼，免得丢掉字体族
				context.font = String(context.font).replace(CANVAS_FONT_SIZE_PATTERN, `${args[0]}px`)
				break
			default:
				throw new Error(`Unsupported canvas action: ${type}`)
		}
	}

	replayCanvasPath(context, path = []) {
		context.beginPath()
		for (const step of path) {
			const { type, args = [] } = step || {}
			if (!CANVAS_PATH_STEP_METHODS.has(type)) {
				throw new Error(`Unsupported canvas path action: ${type}`)
			}
			context[type](...args)
		}
	}

	/**
	 * fillStyle / strokeStyle 的值可能是颜色字符串，也可能是逻辑层传来的渐变、图案描述。
	 */
	async resolveCanvasStyle(context, value) {
		if (!value || typeof value !== 'object') {
			return value
		}
		if (value.__canvasStyle === 'gradient') {
			const data = value.data || []
			const gradient = value.type === 'radial'
				// 旧版 createCircularGradient(x, y, r) 是以 (x, y) 为共同圆心的径向渐变
				? context.createRadialGradient(data[0], data[1], 0, data[0], data[1], data[2])
				: context.createLinearGradient(data[0], data[1], data[2], data[3])
			for (const [stop, color] of value.colorStop || []) {
				gradient.addColorStop(stop, color)
			}
			return gradient
		}
		if (value.__canvasStyle === 'pattern') {
			const image = await this.loadCanvasImage(value.image)
			return context.createPattern(image, value.repetition)
		}
		return value
	}

	/**
	 * reserve:false 通过重建 backing store 同时清除像素、裁剪区、save 栈和绘图状态。
	 * 微信 iOS 的底层字号是例外：它跨 draw(false) 以及同画布的新 CanvasContext 泄漏。
	 */
	resetCanvasForDraw(context, canvas) {
		const font = context.font
		const { width } = canvas
		canvas.width = width
		context.font = font
	}

	/**
	 * draw(reserve) 只保留像素，不保留绘图状态：官方示例里第二批没重设 fillStyle 时画出来是默认黑色。
	 * 保留像素就不能重建 backing store，因此用一层基线 save 帧承载整批状态——
	 * 下批开始时弹掉它，样式、变换和裁剪区一起回到默认值，画面不动。
	 * 微信 iOS 的底层字号是例外：它跨批次泄漏，两条重置路径都要把 font 带回来。
	 */
	beginCanvasBatch(context, canvas, reserve) {
		const previous = this.canvasBatchFrames.get(canvas)
		if (reserve && previous) {
			const font = context.font
			// 基线帧之上还剩多少批内 save 就弹多少，最后一次弹的才是基线帧本身。
			for (let i = 0; i <= previous.depth; i++) {
				context.restore()
			}
			context.font = font
		}
		else if (!reserve) {
			this.resetCanvasForDraw(context, canvas)
		}
		context.save()
		const frame = { depth: 0 }
		this.canvasBatchFrames.set(canvas, frame)
		return frame
	}

	/**
	 * 同一块画布上的异步操作必须串行：回放要等图片加载，导出和像素操作要等回放完成。
	 * 实际 canvas 元素是队列身份的唯一真相源；同名但不同作用域的画布互不阻塞。
	 */
	enqueueCanvasTask(canvas, task) {
		const previous = this.canvasDrawQueues.get(canvas) || Promise.resolve()
		const current = previous.then(task)
		const done = current.catch(() => {}).then(() => {
			if (this.canvasDrawQueues.get(canvas) === done) {
				this.canvasDrawQueues.delete(canvas)
			}
		})
		this.canvasDrawQueues.set(canvas, done)
		return done
	}

	enqueueCanvasScopeTask(scopeKey, task) {
		const previous = this.canvasScopeQueues.get(scopeKey) || Promise.resolve()
		const current = previous.then(task)
		const done = current.catch(() => {}).then(() => {
			if (this.canvasScopeQueues.get(scopeKey) === done) {
				this.canvasScopeQueues.delete(scopeKey)
			}
		})
		this.canvasScopeQueues.set(scopeKey, done)
		return done
	}

	queueCanvasOperation({ bridgeId, params }, operation) {
		const scopeKey = JSON.stringify([bridgeId, params.moduleId || bridgeId])
		let resolution
		const lookupDone = this.enqueueCanvasScopeTask(scopeKey, async () => {
			if (params.canvasValidationError) {
				resolution = { canvas: null, lookupError: null }
				return
			}
			let canvas
			let lookupError
			try {
				canvas = await this.getCanvasElement(params.canvasId, params.moduleId, bridgeId)
			}
			catch (error) {
				lookupError = error
			}
			resolution = { canvas, lookupError }
		})
		return lookupDone.then(() => {
			const { canvas, lookupError } = resolution
			const task = () => operation.call(this, { bridgeId, params, canvas, lookupError })
			return canvas ? this.enqueueCanvasTask(canvas, task) : task()
		})
	}

	drawCanvas(request) {
		return this.queueCanvasOperation(request, this.runCanvasDraw)
	}

	async runCanvasDraw({ bridgeId, params, canvas, lookupError }) {
		const { canvasId, actions = [], reserve = false } = params
		try {
			if (lookupError) {
				throw lookupError
			}
			if (!canvas) {
				this.triggerCanvasFailure(bridgeId, params, `drawCanvas:fail canvas ${canvasId} not found`)
				return
			}

			// 分辨率变化会重建 backing store，上一批的基线帧随之消失，不能再去弹它。
			if (this.ensureCanvasResolution(canvas)) {
				this.canvasBatchFrames.delete(canvas)
			}
			const context = canvas.getContext('2d')

			const frame = this.beginCanvasBatch(context, canvas, reserve)
			await this.replayCanvasActions(context, actions, frame)
			const result = { errMsg: 'drawCanvas:ok' }
			this.triggerCallback(bridgeId, params.success, result, result)
			this.triggerCallback(bridgeId, params.complete, result, result)
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `drawCanvas:fail ${error.message}`)
		}
	}

	/**
	 * 导出也排进这块画布的队列，否则会拍到刚被清屏、或者还在等图片的半成品画面。
	 */
	canvasToTempFilePath(request) {
		return this.queueCanvasOperation(request, this.runCanvasToTempFilePath)
	}

	async runCanvasToTempFilePath({ bridgeId, params, canvas, lookupError }) {
		const fileType = params.fileType === 'jpg' || params.fileType === 'png' ? params.fileType : 'png'

		try {
			if (params.canvasValidationError) {
				this.triggerCanvasFailure(bridgeId, params, `canvasToTempFilePath:fail ${params.canvasValidationError}`)
				return
			}
			if (lookupError) {
				throw lookupError
			}
			if (!canvas) {
				this.triggerCanvasFailure(bridgeId, params, `canvasToTempFilePath:fail canvas ${params.canvasId} not found`)
				return
			}
			const requestedX = Number(params.x) || 0
			const requestedY = Number(params.y) || 0
			const x = requestedX < 0 || requestedX > canvas.width ? 0 : requestedX
			const y = requestedY < 0 || requestedY > canvas.height ? 0 : requestedY
			const requestedWidth = Number(params.width)
			const requestedHeight = Number(params.height)
			const exportWidth = requestedWidth ? Math.min(canvas.width - x, requestedWidth) : canvas.width - x
			const exportHeight = requestedHeight ? Math.min(canvas.height - y, requestedHeight) : canvas.height - y
			const { height: outputHeight, width: outputWidth } = resolveCanvasExportSize({
				destHeight: params.destHeight,
				destWidth: params.destWidth,
				fallbackHeight: exportHeight,
				fallbackWidth: exportWidth,
				pixelRatio: params.pixelRatio,
			})
			const outputCanvas = document.createElement('canvas')
			outputCanvas.width = outputWidth
			outputCanvas.height = outputHeight
			const outputContext = outputCanvas.getContext('2d')
			if (!outputContext) {
				throw new Error('2d context is unavailable')
			}
			outputContext.drawImage(
				canvas,
				x,
				y,
				exportWidth,
				exportHeight,
				0,
				0,
				outputWidth,
				outputHeight,
			)

			const mimeType = fileType === 'jpg' ? 'image/jpeg' : 'image/png'
			const numericQuality = Number(params.quality)
			const quality = fileType !== 'jpg'
				|| Number.isNaN(numericQuality)
				|| numericQuality <= 0
				|| numericQuality > 1
				? 1
				: numericQuality
			const dataURL = outputCanvas
				.toDataURL(mimeType, quality)
				.replace(/^data:image\/(jpg|jpeg|png);base64,/, '')

			message.invoke({
				type: 'invokeAPI',
				target: 'container',
				body: {
					name: 'saveCanvasTempFile',
					bridgeId,
					params: {
						dataURL,
						fileType,
						success: params.success,
						fail: params.fail,
						complete: params.complete,
					},
				},
			})
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `canvasToTempFilePath:fail ${error.message}`)
		}
	}

	canvasGetImageData(request) {
		return this.queueCanvasOperation(request, this.runCanvasGetImageData)
	}

	async runCanvasGetImageData({ bridgeId, params, canvas, lookupError }) {
		try {
			if (params.canvasValidationError) {
				this.triggerCanvasFailure(bridgeId, params, `canvasGetImageData:fail ${params.canvasValidationError}`)
				return
			}
			if (lookupError) {
				throw lookupError
			}
			if (!canvas) {
				this.triggerCanvasFailure(bridgeId, params, `canvasGetImageData:fail canvas ${params.canvasId} not found`)
				return
			}
			const budgetError = canvasPixelBudgetError(params.width, params.height, { transferable: true })
			if (budgetError) {
				this.triggerCanvasFailure(bridgeId, params, `canvasGetImageData:fail ${budgetError}`)
				return
			}
			const context = canvas.getContext('2d')
			const imageData = context.getImageData(params.x, params.y, params.width, params.height)
			const result = {
				width: imageData.width,
				height: imageData.height,
				data: Array.from(imageData.data),
				errMsg: 'canvasGetImageData:ok',
			}
			this.triggerCallback(bridgeId, params.success, result, result)
			this.triggerCallback(bridgeId, params.complete, result, result)
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `canvasGetImageData:fail ${error.message}`)
		}
	}

	canvasPutImageData(request) {
		return this.queueCanvasOperation(request, this.runCanvasPutImageData)
	}

	async runCanvasPutImageData({ bridgeId, params, canvas, lookupError }) {
		try {
			if (params.canvasValidationError) {
				this.triggerCanvasFailure(bridgeId, params, `canvasPutImageData:fail ${params.canvasValidationError}`)
				return
			}
			if (lookupError) {
				throw lookupError
			}
			if (!canvas) {
				this.triggerCanvasFailure(bridgeId, params, `canvasPutImageData:fail canvas ${params.canvasId} not found`)
				return
			}
			const budgetError = canvasPixelBudgetError(params.width, params.height, { transferable: true })
			if (budgetError) {
				this.triggerCanvasFailure(bridgeId, params, `canvasPutImageData:fail ${budgetError}`)
				return
			}
			const context = canvas.getContext('2d')
			const imageData = context.createImageData(params.width, params.height)
			imageData.data.set(params.data || [])
			context.putImageData(imageData, params.x, params.y)
			const result = { errMsg: 'canvasPutImageData:ok' }
			this.triggerCallback(bridgeId, params.success, result, result)
			this.triggerCallback(bridgeId, params.complete, result, result)
		}
		catch (error) {
			this.triggerCanvasFailure(bridgeId, params, `canvasPutImageData:fail ${error.message}`)
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
