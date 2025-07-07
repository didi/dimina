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
		if (key.startsWith('$') || key.startsWith('_l' || key.startsWith('_fl'))) {
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
				.map(item => (typeof item === 'object' ? filterData(item) : item))
		}
		else if (value && typeof value === 'object' && !Array.isArray(value)) {
			// 如果值是对象（非数组），递归过滤该对象中的函数
			acc[key] = filterData(value)
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
 */
export function filterInvokeObserver(changedKey, observers, data, ctx) {
	for (const observerKey in observers) {
		const observerFn = observers[observerKey]

		// 处理简单字段匹配和组合字段匹配
		const keys = observerKey.split(',').map(k => k.trim())

		if (keys.includes(changedKey)) {
			const args = keys.map(key => get(data, key))
			observerFn.call(ctx, ...args)
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
			observerFn.call(ctx, targetData)
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
 * @param {*} obj
 * @param {*} behaviors
 */
export function mergeBehaviors(obj, behaviors) {
	if (!Array.isArray(behaviors)) {
		return
	}

	// 使用 Map 缓存已处理的 behavior
	const processedBehaviors = new WeakMap()

	function merge(target, behavior) {
		// 检查behavior是否为有效的对象，并且可以用作WeakMap的键
		// WeakMap只能使用对象作为键，不能使用null、undefined、字符串等基本类型
		if (!behavior || typeof behavior !== 'object' || typeof behavior === 'string') {
			// 处理内置 behavior 字符串
			if (typeof behavior === 'string') {
				handleBuiltinBehavior(target, behavior)
			}
			return
		}
		
		if (processedBehaviors.has(behavior)) {
			return
		}
		processedBehaviors.set(behavior, true)

		// 合并属性
		if (behavior.properties) {
			target.properties = { ...behavior.properties, ...target.properties }
		}

		// 合并数据
		if (behavior.data) {
			target.data = { ...behavior.data, ...target.data }
		}

		// 合并生命周期
		const lifetimes = ['created', 'attached', 'ready', 'detached']
		target.behaviorLifetimes = target.behaviorLifetimes || {}

		for (const lifetime of lifetimes) {
			if (isFunction(behavior[lifetime])) {
				target.behaviorLifetimes[lifetime] = target.behaviorLifetimes[lifetime] || []
				target.behaviorLifetimes[lifetime].push(behavior[lifetime])
			}
		}

		// 合并方法
		if (behavior.methods) {
			target.methods = { ...behavior.methods, ...target.methods }
		}

		// 合并关系
		if (behavior.relations) {
			target.relations = { ...behavior.relations, ...target.relations }
		}

		// 合并 export 方法 (用于 wx://component-export)
		if (behavior.export) {
			target.export = behavior.export
		}

		// 递归合并
		if (Array.isArray(behavior.behaviors)) {
			behavior.behaviors.forEach(b => merge(target, b))
		}
	}

	/**
	 * 处理内置 behavior
	 * @param {*} target 目标对象
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
			// 可以添加更多内置 behavior 的处理
			default:
				console.warn(`[service] 未知的内置 behavior: ${behaviorName}`)
		}
	}

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
