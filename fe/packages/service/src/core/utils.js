import { get, isFunction, isNil } from '@dimina/common'

const queue = []
let isFlushing = false

export function nextTick(fn) {
	queue.push(fn)
	if (!isFlushing) {
		isFlushing = true
		Promise.resolve().then(flushQueue)
	}
}

function flushQueue() {
	isFlushing = false
	while (queue.length > 0) {
		const cb = queue.shift()
		if (cb) {
			cb()
		}
	}
}

export function deepEqual(a, b) {
	if (a === b)
		return true // 引用相同
	if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null)
		return false

	const keysA = Object.keys(a)
	const keysB = Object.keys(b)
	if (keysA.length !== keysB.length)
		return false

	return keysA.every(key => deepEqual(a[key], b[key]))
}
export function addComputedData(self) {
	// Fixme: 兼容 mpx 的 computed 属性
	if (self.__mpxProxy?.options?.computed) {
		Object.keys(self.__mpxProxy.options.computed).forEach((ck) => {
			// https://github.com/didi/mpx/blob/master/packages/core/src/platform/builtInMixins/i18nMixin.js
			if (ck !== '_l' && ck !== '_fl') {
				// https://github.com/didi/mpx/blob/f1bd7c32ec48c4401ab1bf68247bc68834ca932b/docs-vuepress/articles/mpx2.md?plain=1#L505
				if (!Object.hasOwn(self.data, ck)) {
					self.data[ck] = null
				}
			}
		})
	}
}

export function filterData(obj) {
	if (isNil(obj)) {
		return obj
	}
	return Object.entries(obj).reduce((acc, [key, value]) => {
		if (key.startsWith('$') || key.startsWith('_l') || key.startsWith('_fl')) {
			// 过滤以 $ 开头的属性，未完全过滤以 _ 开头的属性
			return acc
		}
		else if (isFunction(value)) {
			console.warn('[service] 值不支持函数引用', key)
			return acc
		}
		else if (Array.isArray(value)) {
			// 如果值是数组，递归过滤其中的函数
			acc[key] = value
				.map(item => {
					if (typeof item === 'object' && item !== null) {
						// 特殊处理 Date 对象，转换为时间戳
						if (item instanceof Date) {
							return item.getTime()
						}
						return filterData(item)
					}
					return item
				})
		}
		else if (value && typeof value === 'object' && !Array.isArray(value)) {
			// 如果值是对象（非数组），递归过滤该对象中的函数
			// 特殊处理 Date 对象，转换为时间戳
			if (value instanceof Date) {
				acc[key] = value.getTime()
			} else {
				acc[key] = filterData(value)
			}
		}
		else {
			// 其他类型（包括简单类型和非函数对象）直接保留
			acc[key] = value
		}

		return acc
	}, {})
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/reference/api/Component.html
 *
 * @param {{type, optionalTypes, value, observer}} properties
 */
export function serializeProps(properties) {
	if (properties) {
		const props = {}
		for (const key in properties) {
			const item = properties[key]
			props[key] = props[key] || {}

			// 处理 type 字段
			// 兼容 items: Array 和 item: { type: String, value: '' } 两种形式
			const transType = item && typeof item === 'object' && Object.hasOwn(item, 'type') ? convertToStringType(item.type) : convertToStringType(item)
			let array = null
			if (Array.isArray(transType)) {
				array = [...transType]
			}
			else {
				array = [transType]
			}

			// 处理 optionalTypes 字段
			if (item && item.optionalTypes) {
				const oTransType = convertToStringType(item.optionalTypes)
				if (Array.isArray(oTransType)) {
					array = [...oTransType]
				}
				else {
					array.push(oTransType)
				}
			}
			props[key].type = array
			if (props[key].type.length > 0) {
				if (item && isFunction(item.value)) {
					props[key].default = item.value()
				}
				else if (item) {
					props[key].default = item.value
				}
			}

			// 标记处理 observer 字段
			// if (item.observer) {
			// 	props[key].observer = true
			// }
		}
		return props
	}
}

const TYPE_TO_STRING_MAP = new Map([
	[String, 's'],
	[Number, 'n'],
	[Boolean, 'b'],
	[Object, 'o'],
	[Array, 'a'],
	[Function, 'f'],
])

/**
 * 属性的类型可以为 String Number Boolean Object Array 其一，也可以为 null 表示不限制类型。
 * 将实际类型转换成字符串方便传输
 * @param {*} type
 */
function convertToStringType(type) {
	// 检查输入是否为数组
	if (Array.isArray(type)) {
		// 如果是数组，则遍历并转换每个元素
		return type.map(item => convertToStringType(item))
	}
	else {
		// 否则，检查并返回对应的字符串类型
		// 处理 null 或空字符串
		if (type === null || type === '') {
			return null
		}

		// 从映射表中获取类型
		const stringType = TYPE_TO_STRING_MAP.get(type)
		if (stringType) {
			return stringType
		}
		console.warn(`[service] ignore unknown props type ${type}`)
		return null
	}
}

/**
 * 触发数据监听器，一次 setData 最多触发每个监听器一次
 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/observer.html
 * @param {*} changedKey
 * @param {*} observers
 * @param {*} data
 * @param {*} ctx
 * @param {*} oldVal
 */
export function filterInvokeObserver(changedKey, observers, data, ctx, oldVal) {
	for (const observerKey in observers) {
		const observerFn = observers[observerKey]

		// 处理简单字段匹配和组合字段匹配
		const keys = observerKey.split(',').map(k => k.trim())

		if (keys.includes(changedKey)) {
			const args = keys.map(key => get(data, key))
			// 对于单个字段的观察器，如果正好是变化的字段，添加 oldVal 参数
			if (keys.length === 1 && keys[0] === changedKey) {
				observerFn.call(ctx, ...args, oldVal)
			} else {
				observerFn.call(ctx, ...args)
			}
			continue
		}

		// 处理通配符 ** 匹配
		if (observerKey === '**') {
			observerFn.call(ctx, data)
			continue
		}

		// 处理子字段匹配
		const observerKeyParts = observerKey.split('.')
		const changedKeyParts = changedKey.split('.')
		let matched = true
		for (let i = 0; i < observerKeyParts.length; i++) {
			if (observerKeyParts[i] === '**' || changedKeyParts[i] === undefined) {
				break
			}
			else if (observerKeyParts[i] !== changedKeyParts[i]) {
				matched = false
				break
			}
		}
		if (matched) {
			let targetData = data
			for (const part of observerKeyParts) {
				if (part !== '**') {
					targetData = targetData[part]
				}
			}
			// 对于完全匹配的字段，添加 oldVal 参数
			if (observerKey === changedKey) {
				observerFn.call(ctx, targetData, oldVal)
			} else {
				observerFn.call(ctx, targetData)
			}
			continue
		}

		// 处理数组字段匹配
		const arrayMatch = observerKey.match(/^(.+)\[(\d+)\]$/)
		if (arrayMatch) {
			const arrayKey = arrayMatch[1]
			const index = Number.parseInt(arrayMatch[2], 10)
			if (arrayKey === changedKey.split('[')[0] && data[arrayKey] && data[arrayKey][index] !== undefined) {
				observerFn.call(ctx, data[arrayKey][index])
				continue
			}
		}

		// 处理包含子字段的匹配，如 some.subfield
		if (changedKey.startsWith(observerKey)) {
			const targetData = observerKey.split('.').reduce((acc, key) => acc && acc[key], data)
			if (targetData !== undefined) {
				observerFn.call(ctx, targetData)
				continue
			}
		}
	}
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/behaviors.html
 * 
 * 同名字段的覆盖和组合规则：
 * 1. properties 和 methods: 组件覆盖 behavior, 靠后的 behavior 覆盖靠前的, 引用者覆盖被引用者
 * 2. data: 对象类型深度合并, 其他类型按优先级覆盖
 * 3. 生命周期和 observers: 不覆盖, 按顺序执行 (被引用的 > 引用者 > 靠前的 > 靠后的)
 * 4. 同一个 behavior 被多次引用时不会重复执行
 * 
 * @param {*} obj
 * @param {*} behaviors
 */
export function mergeBehaviors(obj, behaviors) {
	if (!Array.isArray(behaviors)) {
		return
	}

	// 使用 WeakMap 缓存已处理的 behavior,避免重复执行生命周期和 observers
	const processedBehaviors = new WeakMap()

	/**
	 * 深度合并对象类型的 data 字段
	 * @param {object} target 目标对象
	 * @param {object} source 源对象
	 * @returns {object} 合并后的对象
	 */
	function deepMergeData(target, source) {
		const result = { ...target }
		
		for (const key in source) {
			if (Object.hasOwn(source, key)) {
				const targetValue = result[key]
				const sourceValue = source[key]
				
				// 如果两个值都是对象类型(非 null、非数组),则递归合并
				if (
					targetValue && 
					typeof targetValue === 'object' && 
					!Array.isArray(targetValue) &&
					sourceValue && 
					typeof sourceValue === 'object' && 
					!Array.isArray(sourceValue)
				) {
					result[key] = deepMergeData(targetValue, sourceValue)
				} else {
					// 其他情况直接覆盖(遵循优先级规则)
					result[key] = sourceValue
				}
			}
		}
		
		return result
	}

	/**
	 * 递归合并单个 behavior
	 * @param {object} target 目标对象
	 * @param {object} behavior behavior 对象
	 */
	function merge(target, behavior) {
		// 处理内置 behavior 字符串
		if (typeof behavior === 'string') {
			handleBuiltinBehavior(target, behavior)
			return
		}

		// 检查 behavior 是否为有效的对象
		if (!behavior || typeof behavior !== 'object') {
			return
		}
		
		// 检查是否已处理过该 behavior(避免重复执行生命周期和 observers)
		if (processedBehaviors.has(behavior)) {
			return
		}
		processedBehaviors.set(behavior, true)

		// 先递归处理嵌套的 behaviors(被引用的 behavior 优先于引用者 behavior)
		if (Array.isArray(behavior.behaviors)) {
			behavior.behaviors.forEach(b => merge(target, b))
		}

	// 合并 properties
	// 规则: 组件本身覆盖 behavior, 靠后的 behavior 覆盖靠前的, 引用者覆盖被引用者
	if (behavior.properties) {
		target.properties = { ...behavior.properties, ...target.properties }
	}

		// 合并 data
		// 规则: 组件本身覆盖 behavior, 对象类型深度合并, 其他类型按优先级覆盖
		if (behavior.data) {
			if (!target.data) {
				target.data = {}
			}
			target.data = deepMergeData(behavior.data, target.data)
		}

		// 合并生命周期函数
		// 规则: 不覆盖, 按顺序执行 (被引用的 > 引用者 > 靠前的 > 靠后的)
		const lifetimes = ['created', 'attached', 'ready', 'detached']
		target.behaviorLifetimes = target.behaviorLifetimes || {}

		for (const lifetime of lifetimes) {
			if (isFunction(behavior[lifetime])) {
				target.behaviorLifetimes[lifetime] = target.behaviorLifetimes[lifetime] || []
				target.behaviorLifetimes[lifetime].push(behavior[lifetime])
			}
		}

		// 合并 observers
		// 规则: 不覆盖, 按顺序执行 (被引用的 > 引用者 > 靠前的 > 靠后的)
		if (behavior.observers) {
			target.behaviorObservers = target.behaviorObservers || {}
			
			for (const observerKey in behavior.observers) {
				if (!target.behaviorObservers[observerKey]) {
					target.behaviorObservers[observerKey] = []
				}
				target.behaviorObservers[observerKey].push(behavior.observers[observerKey])
			}
		}

	// 合并 methods
	// 规则: 组件本身覆盖 behavior, 靠后的 behavior 覆盖靠前的, 引用者覆盖被引用者
	if (behavior.methods) {
		target.methods = { ...behavior.methods, ...target.methods }
	}

		// 合并 relations
		// 规则: 靠后的覆盖靠前的
		if (behavior.relations) {
			target.relations = { ...target.relations, ...behavior.relations }
		}

		// 合并 export 方法 (用于 wx://component-export)
		// 规则: 靠后的覆盖靠前的
		if (behavior.export) {
			target.export = behavior.export
		}

		// 合并 pageLifetimes (页面生命周期)
		// 规则: 不覆盖, 按顺序执行
		if (behavior.pageLifetimes) {
			target.behaviorPageLifetimes = target.behaviorPageLifetimes || {}
			const pageLifetimes = ['show', 'hide', 'resize']
			
			for (const lifetime of pageLifetimes) {
				if (isFunction(behavior.pageLifetimes[lifetime])) {
					target.behaviorPageLifetimes[lifetime] = target.behaviorPageLifetimes[lifetime] || []
					target.behaviorPageLifetimes[lifetime].push(behavior.pageLifetimes[lifetime])
				}
			}
		}
	}

	/**
	 * 处理内置 behavior
	 * @param {object} target 目标对象
	 * @param {string} behaviorName behavior 名称
	 */
	function handleBuiltinBehavior(target, behaviorName) {
		switch (behaviorName) {
			case 'wx://component-export':
				// wx://component-export behavior 不需要额外的合并操作
				// 只需要确保 behaviors 数组中包含这个 behavior
				break
			case 'wx://form-field':
				// 表单字段 behavior 的处理
				// 这里可以添加表单字段相关的属性和方法
				break
			case 'wx://form-field-button':
				// TODO: https://developers.weixin.qq.com/miniprogram/dev/component/form.html#wx-form-field-button
				break
			default:
				console.warn(`[service] 未知的内置 behavior: ${behaviorName}`)
		}
	}

	// 按顺序合并所有 behaviors (靠前的先执行)
	behaviors.forEach(behavior => merge(obj, behavior))
}

/**
 * 检查一个组件是否是指定组件的子组件(包括深层嵌套)
 * ComponentA (__id__: 'a')
  └─ ComponentB (__id__: 'b', __parentId__: 'a')
      └─ ComponentC (__id__: 'c', __parentId__: 'b', class: 'target')
 * @param {object} component 待检查的组件
 * @param {string} parentId 父组件ID
 * @param {Array} allComponents 所有组件列表
 * @returns {boolean} 是否为子组件
 */
export function isChildComponent(component, parentId, allComponents) {
	let parent = component
	while (parent && parent.__parentId__) {
		if (parent.__parentId__ === parentId) {
			return true
		}
		// 向上查找父组件
		parent = allComponents.find(item => item.__id__ === parent.__parentId__)
	}
	return false
}

/**
 * 根据选择器匹配组件
 * @param {string} selector 选择器
 * @param {object} item 待匹配的组件
 * @returns {boolean} 是否匹配
 */
export function matchComponent(selector, item) {
	if (!selector || !item) {
		return false
	}

	// ID 选择器 #id
	if (selector.startsWith('#')) {
		const id = selector.slice(1)
		return item.id === id
	}
	
	// 类选择器 .class
	if (selector.startsWith('.')) {
		const className = selector.slice(1)
		return item.__targetInfo__?.class
			&& item.__targetInfo__.class.split(' ').includes(className)
	}
	
	// 属性选择器 [attr=value]
	if (selector.startsWith('[') && selector.endsWith(']')) {
		const attrMatch = selector.slice(1, -1).match(/^(\w+)(?:=["']?([^"']*)["']?)?$/)
		if (attrMatch) {
			const [, attrName, attrValue] = attrMatch
			const dataset = item.__targetInfo__?.dataset || {}
			
			// 如果只指定了属性名，检查属性是否存在
			if (attrValue === undefined) {
				return Object.hasOwn(dataset, attrName)
			}
			
			// 如果指定了属性值，检查属性值是否匹配
			return dataset[attrName] === attrValue
		}
		return false
	}
	
	// 标签选择器 tag-name
	// 匹配组件的路径名或组件名
	if (item.is) {
		const componentName = item.is.split('/').pop() // 获取路径的最后一部分
		return componentName === selector || item.is === selector
	}
	
	return false
}

/**
 * 检查表达式的依赖是否发生变化
 * @param {object} bindingInfo 绑定信息对象（包含 expression, dependencies, isSimple）
 * @param {object} changedData 变化的数据
 * @returns {boolean} 是否有依赖变化
 */
function hasDependencyChanged(bindingInfo, changedData) {
	if (!bindingInfo || !Array.isArray(bindingInfo.dependencies)) {
		return false
	}
	
	// 检查任一依赖是否在 changedData 中
	for (const dep of bindingInfo.dependencies) {
		if (dep in changedData) {
			return true
		}
		
		// 检查嵌套路径，如 changedData 有 'item' 变化，则 'item.name' 也应更新
		// 或者 changedData 有 'item.name' 变化，则依赖 'item' 的表达式也应更新
		for (const changedKey of Object.keys(changedData)) {
			// changedKey 是 dep 的子路径
			if (changedKey.startsWith(dep + '.') || changedKey.startsWith(dep + '[')) {
				return true
			}
			// dep 是 changedKey 的子路径
			if (dep.startsWith(changedKey + '.') || dep.startsWith(changedKey + '[')) {
				return true
			}
		}
	}
	
	return false
}

/**
 * 计算表达式的新值
 * @param {object} bindingInfo 绑定信息对象（包含 expression, dependencies, isSimple）
 * @param {object} parentData 父组件的完整数据
 * @returns {*} 计算后的值
 */
function evaluateExpression(bindingInfo, parentData) {
	if (!bindingInfo || !bindingInfo.expression) {
		return undefined
	}
	
	if (bindingInfo.isSimple) {
		// 简单绑定：直接获取值
		return get(parentData, bindingInfo.expression)
	}
	
	// 复杂表达式：创建一个安全的求值环境
	try {
		// 创建一个函数来安全地计算表达式
		// 将父组件数据作为作用域
		// eslint-disable-next-line no-new-func
		const func = new Function('data', `with(data) { return ${bindingInfo.expression} }`)
		return func(parentData)
	} catch (error) {
		console.warn('[service] 计算表达式失败:', bindingInfo.expression, error)
		return undefined
	}
}

/**
 * 同步更新子组件的 properties
 * 在父组件/页面 setData 时，同步更新所有受影响的子组件，确保 selectComponent 能立即获取到最新值
 * 完全依赖编译器提供的绑定关系，支持复杂表达式
 * @param {object} parent 父组件或页面实例
 * @param {object} allInstances 所有组件实例对象（来自 runtime.instances[bridgeId]）
 * @param {object} changedData 父组件变化的数据（新值）
 */
export function syncUpdateChildrenProps(parent, allInstances, changedData) {
	const children = Object.values(allInstances || {})
	
	// 遍历所有子组件
	for (const child of children) {
		// 只处理当前组件/页面的直接子组件
		if (!isChildComponent(child, parent.__id__, children) || child.__parentId__ !== parent.__id__) {
			continue
		}

		// 检查子组件的每个 property 是否需要更新
		const childProperties = child.__info__?.properties || {}
		const updateData = {}
		
		// 使用编译器提供的绑定关系
		for (const propName in childProperties) {
			const bindingInfo = parent.__childPropsBindings__?.[child.__id__]?.[propName]
			
			if (!bindingInfo) {
				continue
			}
			
			// 检查依赖是否变化
			if (hasDependencyChanged(bindingInfo, changedData)) {
				// 重新计算表达式的值
				const newValue = evaluateExpression(bindingInfo, parent.data)
				updateData[propName] = newValue
			}
		}

		// 如果有数据需要更新，触发子组件的 tO 方法，但不触发 observers
		if (Object.keys(updateData).length > 0) {
			child.tO?.(updateData, false)
		}
	}
}
