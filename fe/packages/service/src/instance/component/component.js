import { cloneDeep, isFunction, normalizePropertyDefinition, resolvePropertyValue } from '@dimina/common'
import { createSelectorQuery } from '../../api/core/wxml/selector-query'
import { createIntersectionObserver } from '../../api/core/wxml/intersection-observer'
import { createMediaQueryObserver } from '../../api/core/wxml/media-query-observer'
import { invokeAPI } from '../../api/common'
import message from '../../core/message'
import runtime from '../../core/runtime'
import { applyDataUpdates, invokeDataObservers, invokePropertyChanges } from '../../core/data-update'
import { invokeSafely, invokeSafelyAll } from '../../core/safe-callback'
import { beginUpdateBatch, createUpdateCallback, endUpdateBatch, enqueueUpdate } from '../../core/update-queue'
import { deepEqual, isChildComponent, matchComponent, resolveEventBinding, syncUpdateChildrenProps } from '../../core/utils'

// 组件生命周期
const componentLifetimes = ['created', 'attached', 'ready', 'moved', 'detached', 'error']
// 组件所在页面的生命周期
const pageLifetimes = ['show', 'hide', 'resize', 'routeDone']

/**
 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/Component.html
 */
export class Component {
	constructor(module, opts) {
		this.initd = false
		this.opts = opts
		if (opts.targetInfo) {
			this.id = opts.targetInfo.id
			this.dataset = opts.targetInfo.dataset
			this.__targetInfo__ = opts.targetInfo
		}
		this.is = opts.path
		this.route = opts.path
		this.query = opts.query
		this.renderer = 'webview'
		this.bridgeId = opts.bridgeId
		if (!this.id) {
			this.id = opts.bridgeId
		}
		this.behaviors = module.behaviors
		this.data = cloneDeep(module.noReferenceData)

		Object.defineProperty(this, 'properties', {
			get() {
				return this.data
			},
			enumerable: true,
			configurable: false
		})

		this.__isComponent__ = module.isComponent
		this.__type__ = module.type
		this.__id__ = this.opts.moduleId
		this.__info__ = module.moduleInfo
		this.__eventAttr__ = opts.eventAttr
		this.__eventPath__ = null
		this.__pageId__ = opts.pageId
		this.__parentId__ = opts.parentId
		this.__isCustomTabBar__ = opts.isCustomTabBar === true
		
		// 初始化关系相关属性
		this.__relations__ = new Map() // 存储关系节点
		this.__relationPaths__ = new Map() // 存储关系路径映射
		
		// 初始化 groupSetData 相关属性
		this.__groupSetDataMode__ = false // 是否处于批量更新模式
		this.__groupSetDataBuffer__ = {} // 批量更新数据缓存
		this.__groupSetDataChanges__ = [] // 批量更新路径缓存
		this.__groupSetDataCallbacks__ = [] // 批量更新回调缓存
		this.__pendingInitSetDataCallbacks__ = [] // 初始化期间 setData 回调缓存
	
		// 保存子组件 properties 绑定关系（用于同步更新）
		// 格式：{ childModuleId: { childPropName: parentDataKey } }
		this.__childPropsBindings__ = {}
		this.__pendingSyncedProps__ = {}
		this.__initialPropertyObserversInvoked__ = false
		this.__initialPropertyNames__ = new Set(opts.propertyNames || Object.keys(opts.properties || {}))
		this.__initialPropertyChanges__ = []
		this.__initialPropertyValues__ = {}
		this.__propertySchemas__ = Object.fromEntries(
			Object.entries(this.__info__.properties || {}).map(([name, definition]) => [name, normalizePropertyDefinition(definition)]),
		)
	}

	init({ deferInitialData = false } = {}) {
		this.#initCustomMethods()
		if (this.__isComponent__) {
			const initialProperties = this.opts.properties || {}
			for (const [key, schema] of Object.entries(this.__propertySchemas__)) {
				const absentValue = resolvePropertyValue(schema, undefined, { absent: true })
				this.data[key] = absentValue
				if (this.__initialPropertyNames__.has(key)) {
					const value = this.normalizePropertyValue(key, initialProperties[key], {
						applyFilter: false,
					})
					this.__initialPropertyValues__[key] = value
					this.__initialPropertyChanges__.push({
						propertyName: key,
						oldValue: undefined,
						path: [key],
						value,
					})
				}
			}
		}

		this.#initLifecycle()
		this.#initRelations()
		this.#initComponentExport()
		this.#invokeInitLifecycle()
		if (!deferInitialData) {
			this.sendInitialData()
		}
	}

	sendInitialData() {
		if (this.__initialDataSent__) {
			return
		}
		this.__initialDataSent__ = true
		message.send({
			type: this.__id__,
			target: 'render',
			body: {
				bridgeId: this.bridgeId,
				path: this.is,
				data: this.data,
			},
		})
	}

	flushInitSetDataCallbacks() {
		if (this.__pendingInitSetDataCallbacks__.length === 0) {
			return
		}

		const callbacks = this.__pendingInitSetDataCallbacks__
		this.__pendingInitSetDataCallbacks__ = []
		enqueueUpdate(this.bridgeId, this.__id__, {}, createUpdateCallback(this, callbacks))
	}

	/**
	 * 初始化组件导出功能
	 * 处理 wx://component-export behavior
	 */
	#initComponentExport() {
		// 检查是否使用了 wx://component-export behavior
		if (this.hasBehavior('wx://component-export')) {
			// 如果组件定义了 export 方法，将其绑定到组件实例
			if (this.__info__.export && isFunction(this.__info__.export)) {
				this.export = this.__info__.export.bind(this)
			}
		}
	}

	/**
	 * 初始化组件间关系
	 */
	#initRelations() {
		const relations = this.__info__.relations
		if (!relations || typeof relations !== 'object') {
			return
		}

		// 遍历所有关系配置
		for (const [relationPath] of Object.entries(relations)) {
			// 解析关系路径，处理相对路径
			const resolvedPath = this.#resolveRelationPath(relationPath)
			this.__relationPaths__.set(relationPath, resolvedPath)
			
			// 初始化该关系的节点数组
			if (!this.__relations__.has(relationPath)) {
				this.__relations__.set(relationPath, [])
			}
		}
	}

	/**
	 * 解析关系路径，将相对路径转换为绝对路径
	 */
	#resolveRelationPath(relationPath) {
		if (relationPath.startsWith('./')) {
			// 相对路径，基于当前组件路径解析
			const lastSlashIndex = this.is.lastIndexOf('/')
			if (lastSlashIndex === -1) {
				// 当前组件路径没有目录，直接返回去掉 ./ 的路径
				return relationPath.substring(2)
			}
			const currentDir = this.is.substring(0, lastSlashIndex)
			return `${currentDir}/${relationPath.substring(2)}`
		} else if (relationPath.startsWith('../')) {
			// 上级路径，基于当前组件路径解析
			const pathParts = this.is.split('/')
			const relationParts = relationPath.split('/')
			
			let currentParts = pathParts.slice(0, -1) // 去掉文件名
			
			for (const part of relationParts) {
				if (part === '..') {
					currentParts.pop()
				} else if (part !== '.') {
					currentParts.push(part)
				}
			}
			
			return currentParts.join('/')
		} else {
			// 绝对路径或其他格式
			return relationPath
		}
	}

	/**
	 * 检查组件关系并建立连接
	 */
	#checkAndLinkRelations() {
		const relations = this.__info__.relations
		if (!relations) return

		const allInstances = Object.values(runtime.instances[this.bridgeId] || {}).filter(instance => (
			instance === this
			|| !instance.__isComponent__
			|| instance.__componentAttached__
			|| instance.__componentAttaching__
		))
		
		for (const [relationPath, relationConfig] of Object.entries(relations)) {
			const { type, target } = relationConfig
			const resolvedPath = this.__relationPaths__.get(relationPath)
			
			// 查找匹配的组件
			const matchingComponents = allInstances.filter(instance => {
				// 检查路径匹配
				if (target) {
					// 如果指定了 target behavior，检查组件是否具有该 behavior
					return instance.hasBehavior && instance.hasBehavior(target)
				} else {
					// 检查路径匹配
					return instance.is === resolvedPath || instance.is.endsWith(`/${resolvedPath}`)
				}
			})

			// 根据关系类型过滤组件
			const relatedComponents = matchingComponents.filter(instance => this.#checkRelationType(instance, type))

			// 建立关系连接
			for (const relatedComponent of relatedComponents) {
				this.#linkRelation(relationPath, relatedComponent, relationConfig)
			}
		}
		
		// 通知其他组件重新检查关系（双向关系建立）
		this.#notifyOthersToCheckRelations()
	}

	/**
	 * 通知其他组件重新检查关系
	 */
	#notifyOthersToCheckRelations() {
		const allInstances = Object.values(runtime.instances[this.bridgeId] || {})
		
		for (const instance of allInstances) {
			if (instance !== this && instance._checkRelationsWithTarget) {
				// 只检查与当前组件相关的关系
				instance._checkRelationsWithTarget(this)
			}
		}
	}

	/**
	 * 检查与特定目标组件的关系
	 */
	_checkRelationsWithTarget(targetInstance) {
		const relations = this.__info__.relations
		if (!relations) return
		
		for (const [relationPath, relationConfig] of Object.entries(relations)) {
			const { type, target } = relationConfig
			const resolvedPath = this.__relationPaths__.get(relationPath)
			
			// 检查目标组件是否匹配
			let matches = false
			if (target) {
				matches = targetInstance.hasBehavior && targetInstance.hasBehavior(target)
			} else {
				matches = targetInstance.is === resolvedPath || targetInstance.is.endsWith(`/${resolvedPath}`)
			}
			
			if (matches && this.#checkRelationType(targetInstance, type)) {
				this.#linkRelation(relationPath, targetInstance, relationConfig)
			}
		}
	}

	/**
	 * 检查关系类型是否匹配
	 */
	#checkRelationType(targetInstance, relationType) {
		const allInstances = Object.values(runtime.instances[this.bridgeId] || {})
		
		switch (relationType) {
			case 'parent':
				// 目标组件应该是当前组件的直接父组件
				return targetInstance.__id__ === this.__parentId__
				
			case 'child':
				// 目标组件应该是当前组件的直接子组件
				return targetInstance.__parentId__ === this.__id__
				
			case 'ancestor':
				// 目标组件应该是当前组件的祖先组件
				return this.#isAncestor(targetInstance.__id__, this.__id__, allInstances)
				
			case 'descendant':
				// 目标组件应该是当前组件的后代组件
				return this.#isAncestor(this.__id__, targetInstance.__id__, allInstances)
				
			default:
				return false
		}
	}

	/**
	 * 检查 ancestorId 是否是 descendantId 的祖先
	 */
	#isAncestor(ancestorId, descendantId, allInstances) {
		let current = allInstances.find(instance => instance.__id__ === descendantId)
		
		while (current && current.__parentId__) {
			if (current.__parentId__ === ancestorId) {
				return true
			}
			current = allInstances.find(instance => instance.__id__ === current.__parentId__)
		}
		
		return false
	}

	/**
	 * 建立关系连接
	 */
	#linkRelation(relationPath, targetInstance, relationConfig) {
		const relationNodes = this.__relations__.get(relationPath) || []
		
		// 检查是否已经建立了关系
		if (relationNodes.includes(targetInstance)) {
			return
		}
		
		// 添加到关系节点列表
		relationNodes.push(targetInstance)
		this.__relations__.set(relationPath, relationNodes)
		
		// 调用 linked 生命周期函数
		invokeSafely(this, relationConfig.linked, [targetInstance], 'relation linked callback')
	}

	/**
	 * 移除关系连接
	 */
	#unlinkRelation(relationPath, targetInstance, relationConfig) {
		const relationNodes = this.__relations__.get(relationPath) || []
		const index = relationNodes.indexOf(targetInstance)
		
		if (index === -1) {
			return
		}
		
		// 从关系节点列表中移除
		relationNodes.splice(index, 1)
		this.__relations__.set(relationPath, relationNodes)
		
		// 调用 unlinked 生命周期函数
		invokeSafely(this, relationConfig.unlinked, [targetInstance], 'relation unlinked callback')
	}

	/**
	 * 处理关系变化
	 */
	#handleRelationChange(relationPath, targetInstance, relationConfig) {
		// 调用 linkChanged 生命周期函数
		invokeSafely(this, relationConfig.linkChanged, [targetInstance], 'relation linkChanged callback')
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_setData.html
	 * @param {*} data
	 */
	setData(data, callback) {
		const update = applyDataUpdates(this, data, callback)
		if (!update) {
			return
		}

		if (!this.initd) {
			this.__pendingInitSetDataCallbacks__.push(...update.callbacks)
			invokePropertyChanges(this, update.propertyChanges)
			return
		}

		// 如果处于 groupSetData 模式，将数据缓存起来
		if (this.__groupSetDataMode__) {
			// 合并到缓存中
			for (const key of Object.keys(update.changedData)) {
				this.__groupSetDataBuffer__[key] = update.changedData[key]
			}
			this.__groupSetDataChanges__.push(...update.changes)
			this.__groupSetDataCallbacks__.push(...update.callbacks)
			invokePropertyChanges(this, update.propertyChanges)
			return
		}

		// 同步更新子组件的 properties，确保与微信小程序时序一致
		const syncedChildren = syncUpdateChildrenProps(this, runtime.instances[this.bridgeId], update.changedData)

		enqueueUpdate(
			this.bridgeId,
			this.__id__,
			update.changedData,
			createUpdateCallback(this, update.callbacks),
			update.changes,
		)

		syncedChildren.forEach(({ child, data }) => {
			enqueueUpdate(this.bridgeId, child.__id__, data)
		})

		// exparser runs property observers after the data observer/update phase.
		invokePropertyChanges(this, update.propertyChanges)
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/lifetimes.html
	 */
	#initLifecycle() {
		componentLifetimes.forEach((method) => {
			const lifecycleMethod = this.__info__.lifetimes?.[method] || this.__info__[method]
			if (!isFunction(lifecycleMethod)) {
				return
			}
			this[method] = lifecycleMethod.bind(this)
		})
		if (this.__isComponent__) {
			pageLifetimes.forEach((method) => {
				const lifecycleMethod = this.__info__.pageLifetimes?.[method]
				if (!isFunction(lifecycleMethod)) {
					return
				}
				if (method === 'show') {
					method = 'onShow'
				}
				else if (method === 'hide') {
					method = 'onHide'
				}
				this[method] = lifecycleMethod.bind(this)
			})
		}
	}

	/**
	 * 开发者自定义函数
	 * Component 构造器的主要区别是：方法需要放在 methods: { } 里面
	 */
	#initCustomMethods() {
		const methods = this.__info__.methods
		for (const attr in methods) {
			if (isFunction(methods[attr])) {
				this[attr] = methods[attr].bind(this)
			}
		}
	}

	#invokeInitialPropertyObservers() {
		if (!this.__isComponent__ || !this.__info__.properties || this.__initialPropertyObserversInvoked__) {
			return
		}

		const changedPaths = this.__initialPropertyChanges__.map(change => change.path)
		if (changedPaths.length > 0) {
			invokeDataObservers(this, changedPaths)
			invokePropertyChanges(this, this.__initialPropertyChanges__)
		}
		this.__initialPropertyObserversInvoked__ = true
	}

	#applyInitialProperties() {
		for (const [key, incomingValue] of Object.entries(this.__initialPropertyValues__)) {
			const oldValue = this.data[key]
			const value = this.normalizePropertyValue(key, incomingValue, { oldValue })
			this.data[key] = value
			const change = this.__initialPropertyChanges__.find(item => item.propertyName === key)
			if (change) {
				change.oldValue = oldValue
				change.value = value
			}
		}
	}

	#invokeInitLifecycle() {
		if (this.__isComponent__) {
			// exparser creates the component with declared defaults, then applies
			// incoming template properties and their observers after created.
			this.componentCreated()
			this.#applyInitialProperties()
			this.#invokeInitialPropertyObservers()
		}
		else {
			// 使用 Component 构造器创建的页面生命周期
			this.componentCreated()
			// Component 构造的页面根实例在页面节点树创建阶段进入 attached。
			this.componentAttached()

			invokeSafely(this, this.onLoad, [this.opts.query || {}], 'onLoad')
		}
		this.initd = true
	}

	/**
	 * 触发观察者函数
	 * triggerObserver
	 */
	tO(data) {
		const incomingData = typeof this.normalizePropertyValues === 'function'
			? this.normalizePropertyValues(data, { applyFilter: false })
			: data
		const nextData = {}
		const appliedData = {}
		for (const [prop, incomingValue] of Object.entries(incomingData)) {
			if (
				this.__pendingSyncedProps__
				&& Object.prototype.hasOwnProperty.call(this.__pendingSyncedProps__, prop)
				&& deepEqual(this.__pendingSyncedProps__[prop], incomingValue)
			) {
				if (!this.hasPropertyFilter?.(prop)) {
					this.data[prop] = incomingValue
				}
				appliedData[prop] = this.data[prop]
				delete this.__pendingSyncedProps__[prop]
				continue
			}
			const value = typeof this.normalizePropertyValue === 'function'
				? this.normalizePropertyValue(prop, incomingValue)
				: incomingValue
			nextData[prop] = value
			appliedData[prop] = value
		}

		if (Object.keys(nextData).length === 0) {
			return appliedData
		}

		const propertyChanges = []
		const changedPaths = []
		// 保存旧值并更新数据，收集观察者
		for (const [prop, val] of Object.entries(nextData)) {
			// 保存旧值
			const oldVal = this.data[prop]
			// 更新数据
			this.data[prop] = val
			changedPaths.push([prop])
			propertyChanges.push({ propertyName: prop, oldValue: oldVal, path: [prop], value: val })
		}

		invokeDataObservers(this, changedPaths)
		invokePropertyChanges(this, propertyChanges)
		return appliedData
	}

	hasPropertyFilter(prop) {
		const definition = this.__info__.properties?.[prop]
		return !!definition && typeof definition === 'object' && definition.filter != null
	}

	normalizePropertyValue(prop, value, { absent = false, applyFilter = true, oldValue = this.data[prop], path = [prop] } = {}) {
		const schema = this.__propertySchemas__[prop]
		if (!schema) {
			return value
		}

		const normalizedValue = resolvePropertyValue(schema, value, { absent })
		if (absent || !applyFilter || !this.hasPropertyFilter(prop)) {
			return normalizedValue
		}

		const definition = this.__info__.properties[prop]
		const filter = isFunction(definition.filter)
			? definition.filter
			: this.__info__.methods?.[definition.filter]
		if (!isFunction(filter)) {
			return normalizedValue
		}

		const filteredValue = invokeSafely(this, filter, [normalizedValue, oldValue, path], 'property filter')
		return filteredValue === undefined ? normalizedValue : filteredValue
	}

	normalizePropertyValues(data, { applyFilter = true } = {}) {
		const normalized = {}
		for (const [prop, value] of Object.entries(data || {})) {
			normalized[prop] = this.normalizePropertyValue(prop, value, { applyFilter })
		}
		return normalized
	}

	getPageId() {
		return this.__id__
	}

	/**
	 * 检查组件是否具有 behavior （检查时会递归检查被直接或间接引入的所有behavior）
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/behaviors.html
	 */
	hasBehavior(behavior) {
		const _hasBehavior = function (behaviors) {
			if (!Array.isArray(behaviors)) {
				return false
			}
			if (behaviors.includes(behavior)) {
				return true
			}
			for (const b of behaviors) {
				if (b && b.behaviors && _hasBehavior(b.behaviors)) {
					return true
				}
			}

			return false
		}
		return _hasBehavior(this.behaviors)
	}

	/**
	 * 创建一个 SelectorQuery 对象，选择器选取范围为这个组件实例内
	 */
	createSelectorQuery() {
		return createSelectorQuery().in(this)
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/events.html#获取组件实例
	 * 使用选择器选取子组件实例对象，返回匹配到的第一个组件实例对象
	 */
	selectComponent(selector) {
		const children = Object.values(runtime.instances[this.bridgeId])

		// 遍历所有组件查找匹配的子组件
		const matchedComponent = children.find(item =>
			isChildComponent(item, this.__id__, children) && matchComponent(selector, item),
		)

		if (!matchedComponent) {
			return null
		}

		// 检查组件是否使用了 wx://component-export behavior
		if (matchedComponent.hasBehavior('wx://component-export') && matchedComponent.export) {
			// 如果组件定义了 export 方法，返回自定义的导出结果
			return matchedComponent.export()
		}

		// 默认返回组件实例本身
		return matchedComponent
	}

	/**
	 * 使用选择器选取子组件实例对象，返回匹配到的全部组件实例对象组成的数组
	 */
	selectAllComponents(selector) {
		const children = Object.values(runtime.instances[this.bridgeId])

		// 遍历所有组件查找匹配的子组件
		return children.filter(item =>
			isChildComponent(item, this.__id__, children) && matchComponent(selector, item),
		)
	}

	/**
	 * 选取当前组件节点所在的组件实例（即组件的引用者），返回它的组件实例对象
	 */
	selectOwnerComponent() {
		const children = Object.values(runtime.instances[this.bridgeId])
		for (const item of children) {
			if (item.id === this.__parentId__) {
				return item
			}
		}
		return null
	}

	/**
	 * 创建一个 IntersectionObserver 对象，选择器选取范围为这个组件实例内
	 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/Component.html#createIntersectionObserver-Object-options
	 */
	createIntersectionObserver(options) {
		return createIntersectionObserver(this, options)
	}

	/**
	 * 立刻执行 callback，其中的多个 setData 之间不会触发界面绘制
	 * （只有某些特殊场景中需要，如用于在不同组件同时 setData 时进行界面绘制同步）
	 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/Component.html#groupSetData-Function-callback
	 * @param {Function} callback 回调函数，在此函数中进行的多个 setData 调用会被合并
	 */
	groupSetData(callback) {
		if (!isFunction(callback)) {
			console.warn('[service] groupSetData callback must be a function')
			return
		}

		// 标记进入批量更新模式
		this.__groupSetDataMode__ = true
		beginUpdateBatch(this.bridgeId)
		
		// 存储批量更新的数据
		this.__groupSetDataBuffer__ = {}
		this.__groupSetDataChanges__ = []
		this.__groupSetDataCallbacks__ = []
		
		try {
			// 执行回调函数
			invokeSafely(this, callback, [], 'groupSetData callback')
		} finally {
			// 退出批量更新模式
			this.__groupSetDataMode__ = false
			
			// 如果有缓存的数据，统一发送更新
			if (this.__groupSetDataBuffer__ && Object.keys(this.__groupSetDataBuffer__).length > 0) {
				const bufferedData = this.__groupSetDataBuffer__
				const bufferedCallbacks = this.__groupSetDataCallbacks__
				const bufferedChanges = this.__groupSetDataChanges__
				this.__groupSetDataBuffer__ = {}
				this.__groupSetDataChanges__ = []
				this.__groupSetDataCallbacks__ = []
				const syncedChildren = syncUpdateChildrenProps(this, runtime.instances[this.bridgeId], bufferedData)
				
				// 发送合并后的数据更新
				enqueueUpdate(this.bridgeId, this.__id__, bufferedData, createUpdateCallback(this, bufferedCallbacks), bufferedChanges)

				syncedChildren.forEach(({ child, data }) => {
					enqueueUpdate(this.bridgeId, child.__id__, data)
				})
			}
			else {
				this.__groupSetDataBuffer__ = {}
				this.__groupSetDataChanges__ = []
				this.__groupSetDataCallbacks__ = []
			}
			endUpdateBatch(this.bridgeId)
		}
	}

	/**
	 * 创建一个 MediaQueryObserver 对象，选择器范围限定在当前组件。
	 */
	createMediaQueryObserver(options) {
		return createMediaQueryObserver(this, options)
	}

	/**
	 * 获取这个关系所对应的所有关联节点
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/relations.html
	 */
	getRelationNodes(relationPath) {
		// exparser 对未声明的 relation 返回 null，已声明但未建立关系时返回空数组。
		const relationNodes = this.__relations__.get(relationPath)
		if (!relationNodes) {
			return null
		}
		
		// 返回节点数组的副本，避免外部修改
		return [...relationNodes]
	}

	/**
	 * 执行关键帧动画。
	 */
	animate(selector, keyframes, duration, timeline, callback) {
		if (isFunction(timeline)) {
			callback = timeline
			timeline = undefined
		}
		invokeAPI('componentAnimate', {
			moduleId: this.__id__,
			selector,
			keyframes,
			duration,
			timeline,
			success: callback,
		}, 'render')
	}

	/**
	 * 清除关键帧动画。
	 */
	clearAnimation(selector, options, callback) {
		if (isFunction(options)) {
			callback = options
			options = {}
		}
		invokeAPI('componentClearAnimation', {
			moduleId: this.__id__,
			selector,
			options: options || {},
			success: callback,
		}, 'render')
	}

	/**
	 * 触发组件所在页面的事件逻辑
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/events.html
	 * @param {*} methodName
	 * @param {*} detail // detail对象，提供给事件监听函数
	 * @param {*} options // 触发事件的选项
	 */
	async triggerEvent(methodName, detail, options = {}) {
		if (!methodName) {
			return
		}
		const type = methodName.trim()
		if (!type) {
			return
		}

		const normalizedOptions = {
			bubbles: options.bubbles === true,
			composed: options.composed === true,
			capturePhase: options.capturePhase === true,
		}
		const target = {
			id: this.id,
			dataset: this.dataset || {},
		}
		let stopped = false
		let defaultPrevented = false
		const event = {
			type,
			timeStamp: Date.now(),
			detail,
			bubbles: normalizedOptions.bubbles,
			composed: normalizedOptions.composed,
			currentTarget: null,
			target,
			preventDefault() {
				defaultPrevented = true
			},
			stopPropagation() {
				stopped = true
			},
		}
		Object.defineProperty(event, 'defaultPrevented', {
			enumerable: true,
			get: () => defaultPrevented,
		})

		const eventPath = Component.prototype.getCustomEventPath.call(this, normalizedOptions.composed)
		const dispatch = async (node, capture) => {
			const binding = resolveEventBinding(node.eventAttr, type)
			if (!binding) {
				return
			}

			const methodName = capture
				? (binding.captureCatch ?? binding.captureBind)
				: (binding.catch ?? binding.bind)
			if (!methodName) {
				return
			}

			event.currentTarget = node.currentTarget
			const result = await runtime.triggerEvent({
				bridgeId: this.bridgeId,
				moduleId: node.moduleId,
				methodName,
				event,
			})
			const isCatch = capture ? Boolean(binding.captureCatch) : Boolean(binding.catch)
			if (isCatch) {
				event.stopPropagation()
			}
			if (result === false) {
				event.preventDefault()
				event.stopPropagation()
			}
		}

		// exparser 的捕获阶段与 bubbles 无关：只要显式开启 capturePhase，
		// 就先按根 -> 目标的顺序执行 capture-bind/capture-catch。
		if (normalizedOptions.capturePhase) {
			for (let i = eventPath.length - 1; i >= 0 && !stopped; i--) {
				await dispatch(eventPath[i], true)
			}
		}

		if (stopped) {
			return
		}

		// 普通阶段始终检查目标节点；bubbles 只控制是否继续走祖先节点。
		const bubblePath = normalizedOptions.bubbles ? eventPath : eventPath.slice(0, 1)
		for (const node of bubblePath) {
			await dispatch(node, false)
			if (stopped) {
				break
			}
		}
	}

	getCustomEventPath(composed) {
		const eventPath = [{
			moduleId: this.__pageId__,
			eventAttr: this.__eventAttr__ || {},
			currentTarget: {
				id: this.id,
				dataset: this.dataset || {},
			},
		}]

		if (Array.isArray(this.__eventPath__)) {
			const renderPath = this.__eventPath__.filter(node => node?.moduleId).map((node) => {
				const hostInstance = node.isComponentHost && node.nodeModuleId
					? runtime.instances[this.bridgeId]?.[node.nodeModuleId]
					: null
				return {
					moduleId: node.moduleId,
					nodeModuleId: node.nodeModuleId,
					isComponentHost: node.isComponentHost === true,
					eventAttr: node.eventAttr || {},
					currentTarget: {
						id: hostInstance?.id ?? node.targetInfo?.id,
						dataset: hostInstance?.dataset || node.targetInfo?.dataset || {},
					},
				}
			})

			// Vue 不会把组件指令传透到 Fragment 根节点。对多根组件，
			// renderPath 仍能记录内部普通节点，但可能缺少组件宿主；
			// 用 service 已有的物理组件链补齐，并插入到该组件内部节点之后。
			const instances = runtime.instances[this.bridgeId] || {}
			const visited = new Set([this.__id__])
			let insertionCursor = 0
			let parent = instances[this.__parentId__]
			while (parent?.__isComponent__ && !visited.has(parent.__id__)) {
				visited.add(parent.__id__)
				const hostIndex = renderPath.findIndex(node => (
					node.isComponentHost && node.nodeModuleId === parent.__id__
				))
				if (hostIndex >= 0) {
					insertionCursor = Math.max(insertionCursor, hostIndex + 1)
				}
				else if (Object.keys(parent.__eventAttr__ || {}).length > 0) {
					let lastInternalIndex = -1
					for (let i = 0; i < renderPath.length; i++) {
						if (renderPath[i].moduleId === parent.__id__) {
							lastInternalIndex = i
						}
					}
					const insertAt = Math.max(insertionCursor, lastInternalIndex + 1)
					renderPath.splice(insertAt, 0, {
						moduleId: parent.__pageId__,
						nodeModuleId: parent.__id__,
						isComponentHost: true,
						eventAttr: parent.__eventAttr__,
						currentTarget: {
							id: parent.id,
							dataset: parent.dataset || {},
						},
					})
					insertionCursor = insertAt + 1
				}
				parent = instances[parent.__parentId__]
			}

			for (const node of renderPath) {
				if (composed || node.moduleId === this.__pageId__) {
					eventPath.push(node)
				}
			}
			return eventPath
		}

		// 旧 render 层或单元测试没有提供 WXML 节点路径时，仍可以沿组件
		// 实例树派发。这条兼容路径不能表示组件内部普通节点，但保留了
		// 组件宿主的 composed 边界语义。
		const instances = runtime.instances[this.bridgeId] || {}
		const visited = new Set([this.__id__])
		let parent = instances[this.__parentId__]
		while (parent?.__isComponent__ && !visited.has(parent.__id__)) {
			visited.add(parent.__id__)
			if (composed || parent.__pageId__ === this.__pageId__) {
				eventPath.push({
					moduleId: parent.__pageId__,
					eventAttr: parent.__eventAttr__ || {},
					currentTarget: {
						id: parent.id,
						dataset: parent.dataset || {},
					},
				})
			}
			parent = instances[parent.__parentId__]
		}
		return eventPath
	}

	pageReady() {
		if (!this.__isComponent__) {
			invokeSafely(this, this.ready, [], 'ready lifetime')
		}
	}

	/**
	 * 页面退出时执行
	 */
	pageUnload() {
		if (!this.__isComponent__) {
			invokeSafely(this, this.onUnload, [], 'onUnload')
		}
	}

	pageScrollTop(opts) {
		if (!this.__isComponent__) {
			const { scrollTop } = opts
			invokeSafely(this, this.onPageScroll, [{ scrollTop }], 'onPageScroll')
		}
	}

	pagePullDownRefresh() {
		if (!this.__isComponent__) {
			invokeSafely(this, this.onPullDownRefresh, [], 'onPullDownRefresh')
		}
	}

	pageReachBottom() {
		if (!this.__isComponent__) {
			invokeSafely(this, this.onReachBottom, [], 'onReachBottom')
		}
	}

	pageShareAppMessage(options = {}) {
		if (!this.__isComponent__) {
			return invokeSafely(this, this.onShareAppMessage, [options], 'onShareAppMessage')
		}

		return undefined
	}

	pageTabItemTap(item = {}) {
		if (!this.__isComponent__) {
			invokeSafely(this, this.onTabItemTap, [item], 'onTabItemTap')
		}
	}

	// --- 组件所在页面的生命周期 ---
	/**
	 * 组件所在的页面被展示时执行
	 */
	pageShow() {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.show, [], 'page show lifetime')
		invokeSafely(this, this.onShow, [], 'page show lifetime')
	}

	/**
	 * 组件所在的页面被隐藏时执行
	 */
	pageHide() {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.hide, [], 'page hide lifetime')
		invokeSafely(this, this.onHide, [], 'page hide lifetime')
	}

	/**
	 * 组件所在的页面尺寸变化时执行
	 * @param {object} size
	 */
	pageResize(size) {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.resize, [size], 'page resize lifetime')
		invokeSafely(this, this.resize, [size], 'page resize lifetime')
	}

	// 组件所在页面路由动画完成时执行
	componentRouteDone() {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.routeDone, [], 'page routeDone lifetime')
		invokeSafely(this, this.routeDone, [], 'page routeDone lifetime')
	}

	// --- 组件的生命周期 ---
	/**
	 * 在组件实例刚刚被创建时执行
	 */
	componentCreated() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.created, [], 'created lifetime')
		invokeSafely(this, this.created, [], 'created lifetime')
	}

	/**
	 * 在组件实例进入页面节点树时执行
	 */
	componentAttached() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.attached, [], 'attached lifetime')
		invokeSafely(this, this.attached, [], 'attached lifetime')
		
		// 建立组件间关系
		this.#checkAndLinkRelations()
	}

	/**
	 * 在组件在视图层布局完成后执行
	 */
	componentReadied() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.ready, [], 'ready lifetime')
		invokeSafely(this, this.ready, [], 'ready lifetime')
	}

	/**
	 * 在组件实例被移动到节点树另一个位置时执行
	 */
	componentMoved() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.moved, [], 'moved lifetime')
		invokeSafely(this, this.moved, [], 'moved lifetime')
		
		// 组件移动后，需要重新检查关系并触发 linkChanged
		const relations = this.__info__.relations
		if (relations) {
			for (const [relationPath, relationConfig] of Object.entries(relations)) {
				const relationNodes = this.__relations__.get(relationPath) || []
				for (const node of relationNodes) {
					this.#handleRelationChange(relationPath, node, relationConfig)
				}
			}
		}
	}

	/**
	 * 在组件实例被从页面节点树移除时执行
	 */
	componentDetached() {
		// exparser marks the node detached before invoking the lifetime, but keeps
		// relation links visible until detached callbacks have completed.
		this.__componentAttached__ = false
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.detached, [], 'detached lifetime')
		invokeSafely(this, this.detached, [], 'detached lifetime')

		// Relation unlinked callbacks run after detached.
		const relations = this.__info__.relations
		if (relations) {
			for (const [relationPath, relationConfig] of Object.entries(relations)) {
				const relationNodes = this.__relations__.get(relationPath) || []
				// 复制数组避免在迭代时修改
				const nodesToUnlink = [...relationNodes]
				for (const node of nodesToUnlink) {
					this.#unlinkRelation(relationPath, node, relationConfig)
				}
			}
		}
		
		// 通知其他组件移除对当前组件的引用
		this.#notifyOthersToUnlinkThis()
		
		this.initd = false
	}
	
	/**
	 * 通知其他组件移除对当前组件的引用
	 */
	#notifyOthersToUnlinkThis() {
		const allInstances = Object.values(runtime.instances[this.bridgeId] || {})
		
		for (const instance of allInstances) {
			if (instance === this || !instance.__relations__) continue
			
			// 遍历其他组件的所有关系
			for (const [relationPath, relationNodes] of instance.__relations__.entries()) {
				const index = relationNodes.indexOf(this)
				if (index !== -1) {
					// 从关系节点列表中移除当前组件
					relationNodes.splice(index, 1)
					instance.__relations__.set(relationPath, relationNodes)
					
					// 调用 unlinked 生命周期函数
					const relationConfig = instance.__info__.relations?.[relationPath]
					invokeSafely(instance, relationConfig?.unlinked, [this], 'relation unlinked callback')
				}
			}
		}
	}

	/**
	 * 每当组件方法抛出错误时执行
	 * @param {*} error
	 */
	componentError(error) {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.error, [error], 'error lifetime', false)
		invokeSafely(this, this.error, [error], 'error lifetime', false)
	}
}
