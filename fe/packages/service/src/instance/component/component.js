import { cloneDeep, isFunction, isString, set } from '@dimina/common'
import { createSelectorQuery } from '../../api/core/wxml/selector-query'
import { createIntersectionObserver } from '../../api/core/wxml/intersection-observer'
import message from '../../core/message'
import runtime from '../../core/runtime'
import { addComputedData, filterData, filterInvokeObserver, isChildComponent, matchComponent, syncUpdateChildrenProps } from '../../core/utils'

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
		this.__pageId__ = opts.pageId
		this.__parentId__ = opts.parentId
		
		// 初始化关系相关属性
		this.__relations__ = new Map() // 存储关系节点
		this.__relationPaths__ = new Map() // 存储关系路径映射
		
		// 初始化 groupSetData 相关属性
		this.__groupSetDataMode__ = false // 是否处于批量更新模式
		this.__groupSetDataBuffer__ = {} // 批量更新数据缓存
	
		// 保存子组件 properties 绑定关系（用于同步更新）
		// 格式：{ childModuleId: { childPropName: parentDataKey } }
		this.__childPropsBindings__ = {}
	}

	init() {
		if (this.__isComponent__) {
			for (const key in this.__info__.properties) {
				// 先取逻辑层的属性默认值
				if (!Object.hasOwn(this.opts.properties, key) || this.opts.properties[key] === undefined) {
					this.data[key] = this.__info__.properties[key]?.value ?? null
				}
				else {
					// 没有默认值则取渲染层的属性实际值
					this.data[key] = this.opts.properties[key]
				}
			}
		}

		this.#initLifecycle()
		this.#initCustomMethods()
		this.#initRelations()
		this.#initComponentExport()
		this.#invokeInitLifecycle().then(() => {
			addComputedData(this)
			message.send({
				type: this.__id__,
				target: 'render',
				body: {
					bridgeId: this.bridgeId,
					path: this.is,
					data: this.data,
				},
			})
		})
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

		const allInstances = Object.values(runtime.instances[this.bridgeId] || {})
		
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
			const relatedComponents = matchingComponents.filter(instance => {
				return this.#checkRelationType(instance, type)
			})

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
		if (isFunction(relationConfig.linked)) {
			try {
				relationConfig.linked.call(this, targetInstance)
			} catch (error) {
				console.error('[service] relation linked error:', error)
			}
		}
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
		if (isFunction(relationConfig.unlinked)) {
			try {
				relationConfig.unlinked.call(this, targetInstance)
			} catch (error) {
				console.error('[service] relation unlinked error:', error)
			}
		}
	}

	/**
	 * 处理关系变化
	 */
	#handleRelationChange(relationPath, targetInstance, relationConfig) {
		// 调用 linkChanged 生命周期函数
		if (isFunction(relationConfig.linkChanged)) {
			try {
				relationConfig.linkChanged.call(this, targetInstance)
			} catch (error) {
				console.error('[service] relation linkChanged error:', error)
			}
		}
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_setData.html
	 * @param {*} data
	 */
	setData(data) {
		const fData = filterData(data)
		
		// 更新数据
		for (const key in fData) {
			set(this.data, key, fData[key])
		}

		if (!this.initd) {
			return
		}

		// 如果处于 groupSetData 模式，将数据缓存起来
		if (this.__groupSetDataMode__) {
			// 合并到缓存中
			for (const key in fData) {
				this.__groupSetDataBuffer__[key] = fData[key]
			}
			return
		}

		// 同步更新子组件的 properties，确保与微信小程序时序一致
		syncUpdateChildrenProps(this, runtime.instances[this.bridgeId], fData)	

		message.send({
			type: 'u',
			target: 'render',
			body: {
				bridgeId: this.bridgeId,
				moduleId: this.__id__,
				data: fData,
			},
		})
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

	async #invokeInitLifecycle() {
		if (this.__isComponent__) {
			// 组件实例创建时调用 componentCreated
			await this.componentCreated()
			// Fixme: 组件已挂载到DOM (componentAttached)
			await this.componentAttached()
		}
		else {
			// 使用 Component 构造器创建的页面生命周期
			await this.componentCreated()
			// Fixme: 组件已挂载到DOM (componentAttached)
			await this.componentAttached()

			await this.onLoad?.(this.opts.query || {})
		}
		this.initd = true
	}

	/**
	 * 触发观察者函数
	 * triggerObserver
	 */
	tO(data, triggerObservers = true) {
		// 收集需要执行的观察者函数
		const observersToExecute = []
		
		// 保存旧值并更新数据，收集观察者
		for (const [prop, val] of Object.entries(data)) {
			// 保存旧值
			const oldVal = this.data[prop]

			// 更新数据
			this.data[prop] = val

			if (triggerObservers) {
				// 收集 observers
				if (this.__info__.observers) {
					observersToExecute.push(() => filterInvokeObserver(prop, this.__info__.observers, data, this, oldVal))
				}
				
				// 收集属性观察器
				const observer = this.__info__.properties?.[prop]?.observer
				if (isString(observer)) {
					observersToExecute.push(() => this[observer]?.(val, oldVal))
				}
				else if (isFunction(observer)) {
					observersToExecute.push(() => observer.call(this, val, oldVal))
				}
			}
		}
		
		// 执行所有观察者函数
		observersToExecute.forEach(fn => fn())
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
		
		// 存储批量更新的数据
		this.__groupSetDataBuffer__ = {}
		
		try {
			// 执行回调函数
			callback.call(this)
		} catch (error) {
			console.error('[service] groupSetData callback error:', error)
		} finally {
			// 退出批量更新模式
			this.__groupSetDataMode__ = false
			
			// 如果有缓存的数据，统一发送更新
			if (this.__groupSetDataBuffer__ && Object.keys(this.__groupSetDataBuffer__).length > 0) {
				const bufferedData = this.__groupSetDataBuffer__
				this.__groupSetDataBuffer__ = {}
				
				// 发送合并后的数据更新
				message.send({
					type: 'u',
					target: 'render',
					body: {
						bridgeId: this.bridgeId,
						moduleId: this.__id__,
						data: bufferedData,
					},
				})
			}
		}
	}

	/**
	 * TODO: 创建一个 MediaQueryObserver 对象
	 */
	createMediaQueryObserver() {
		console.warn('[service] 暂不支持 createMediaQueryObserver')
	}

	/**
	 * 获取这个关系所对应的所有关联节点
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/relations.html
	 */
	getRelationNodes(relationPath) {
		if (!relationPath) {
			console.warn('[service] getRelationNodes 需要传入关系路径参数')
			return []
		}

		// 获取关系节点
		const relationNodes = this.__relations__.get(relationPath) || []
		
		// 返回节点数组的副本，避免外部修改
		return [...relationNodes]
	}

	/**
	 * TODO: 执行关键帧动画
	 */
	animate() {
		console.warn('[service] 暂不支持 animate')
	}

	/**
	 * TODO: 清除关键帧动画
	 */
	clearAnimation() {
		console.warn('[service] 暂不支持 clearAnimation')
	}

	/**
	 * 触发组件所在页面的事件逻辑
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/events.html
	 * @param {*} methodName
	 * @param {*} detail // detail对象，提供给事件监听函数
	 * @param {*} options // 触发事件的选项
	 */
	async triggerEvent(methodName, detail, options = {}) {
		const type = methodName.trim()
		await runtime.triggerEvent({
			bridgeId: this.bridgeId,
			moduleId: this.__pageId__,
			methodName: this.__eventAttr__[type],
			event: {
				type,
				detail,
				currentTarget: {
					id: this.id,
					dataset: this.dataset,
				},
				target: {
					id: this.id,
					dataset: this.dataset,
				},
			},
		})

		// 事件是否冒泡
		if (options.bubbles) {
			// 当前组件的上一级自定义组件
			const parentInstance = runtime.instances[this.bridgeId][this.__parentId__]
			await parentInstance?.triggerEvent(methodName, detail)
		}

		// 事件是否可以穿越组件边界，为false时，事件将只能在引用组件的节点树上触发，不进入其他任何组件内部
		if (options.composed) {
			// TODO:当前组件的上一级自定义组件的内部
		}

		if (options.capturePhase) {
			// TODO:事件是否拥有捕获阶段
		}
	}

	pageReady() {
		if (!this.__isComponent__) {
			this.ready?.()
		}
	}

	/**
	 * 页面退出时执行
	 */
	pageUnload() {
		if (!this.__isComponent__) {
			this.onUnload?.()
		}
	}

	pageScrollTop(opts) {
		if (!this.__isComponent__) {
			const { scrollTop } = opts
			this.onPageScroll?.({ scrollTop })
		}
	}

	// --- 组件所在页面的生命周期 ---
	/**
	 * 组件所在的页面被展示时执行
	 */
	pageShow() {
		this.onShow?.()
	}

	/**
	 * 组件所在的页面被隐藏时执行
	 */
	pageHide() {
		this.onHide?.()
	}

	/**
	 * 组件所在的页面尺寸变化时执行
	 * @param {object} size
	 */
	pageResize(size) {
		this.resize?.(size)
	}

	// 组件所在页面路由动画完成时执行
	componentRouteDone() {
		this.routeDone?.()
	}

	// --- 组件的生命周期 ---
	/**
	 * 在组件实例刚刚被创建时执行
	 */
	async componentCreated() {
		this.__info__.behaviorLifetimes?.created?.forEach(method => method.call(this))
		await this.created?.()
	}

	/**
	 * 在组件实例进入页面节点树时执行
	 */
	async componentAttached() {
		this.__info__.behaviorLifetimes?.attached?.forEach(method => method.call(this))
		await this.attached?.()
		
		// 建立组件间关系
		this.#checkAndLinkRelations()
	}

	/**
	 * 在组件在视图层布局完成后执行
	 */
	componentReadied() {
		this.__info__.behaviorLifetimes?.ready?.forEach(method => method.call(this))
		this.ready?.()
	}

	/**
	 * 在组件实例被移动到节点树另一个位置时执行
	 */
	componentMoved() {
		this.moved?.()
		
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
		// 在组件 detached 前移除所有关系
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
		
		this.__info__.behaviorLifetimes?.detached?.forEach(method => method.call(this))
		this.detached?.()
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
					if (relationConfig && isFunction(relationConfig.unlinked)) {
						try {
							relationConfig.unlinked.call(instance, this)
						} catch (error) {
							console.error('[service] relation unlinked error:', error)
						}
					}
				}
			}
		}
	}

	/**
	 * 每当组件方法抛出错误时执行
	 * @param {*} error
	 */
	componentError(error) {
		this.error?.(error)
	}
}
