export function isFunction(value) {
	return typeof value === 'function'
}

export function isString(value) {
	return typeof value === 'string'
}

export function isNil(value) {
	return value === null || value === undefined
}

export function deepEqual(a, b) {
	if (a === b) {
		return true
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) {
		return false
	}

	const keysA = Object.keys(a)
	const keysB = Object.keys(b)
	if (keysA.length !== keysB.length) {
		return false
	}

	return keysA.every(key => deepEqual(a[key], b[key]))
}

function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key)
}

function isUnsafeProperty(key) {
	return key === '__proto__'
}

function isDeepKey(key) {
	switch (typeof key) {
		case 'number':
		case 'symbol': {
			return false
		}
		case 'string': {
			return key.includes('.') || key.includes('[') || key.includes(']')
		}
	}
}

function isIndex(value, length = Number.MAX_SAFE_INTEGER) {
	switch (typeof value) {
		case 'number': {
			return Number.isInteger(value) && value >= 0 && value < length
		}
		case 'symbol': {
			return false
		}
		case 'string': {
			return /^(?:0|[1-9]\d*)$/.test(value)
		}
	}
}

function isObject(value) {
	return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function isSymbol(value) {
	return typeof value === 'symbol' || Object.prototype.toString.call(value) === '[object Symbol]'
}

function isEqualsSameValueZero(value, other) {
	return value === other || (Number.isNaN(value) && Number.isNaN(other))
}

function toKey(value) {
	if (typeof value === 'string' || typeof value === 'symbol') {
		return value
	}
	if (Object.is(value?.valueOf?.(), -0)) {
		return '-0'
	}
	return String(value)
}

function toPath(value) {
	if (Array.isArray(value)) {
		return value.map(toKey)
	}
	if (typeof value === 'symbol') {
		return [value]
	}

	value = toPathString(value)
	const result = []
	const length = value.length
	if (length === 0) {
		return result
	}

	let index = 0
	let key = ''
	let quoteChar = ''
	let bracket = false
	if (value.charCodeAt(0) === 46) {
		result.push('')
		index++
	}
	while (index < length) {
		const char = value[index]
		if (quoteChar) {
			if (char === '\\' && index + 1 < length) {
				index++
				key += value[index]
			}
			else if (char === quoteChar) {
				quoteChar = ''
			}
			else {
				key += char
			}
		}
		else if (bracket) {
			if (char === '"' || char === '\'') {
				quoteChar = char
			}
			else if (char === ']') {
				bracket = false
				result.push(key)
				key = ''
			}
			else {
				key += char
			}
		}
		else {
			if (char === '[') {
				bracket = true
				if (key) {
					result.push(key)
					key = ''
				}
			}
			else if (char === '.') {
				if (key) {
					result.push(key)
					key = ''
				}
			}
			else {
				key += char
			}
		}
		index++
	}
	if (key) {
		result.push(key)
	}
	return result
}

function toPathString(value) {
	if (value == null) {
		return ''
	}
	if (typeof value === 'string') {
		return value
	}
	if (Array.isArray(value)) {
		return value.map(toPathString).join(',')
	}

	const result = String(value)
	if (result === '0' && Object.is(Number(value), -0)) {
		return '-0'
	}
	return result
}

function isKey(value, object) {
	if (Array.isArray(value)) {
		return false
	}
	if (typeof value === 'number' || typeof value === 'boolean' || value == null || isSymbol(value)) {
		return true
	}
	return (
		typeof value === 'string' && (/^\w*$/.test(value) || !/\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/.test(value))
		|| (object != null && hasOwn(object, value))
	)
}

function getWithPath(object, path, defaultValue) {
	if (path.length === 0) {
		return defaultValue
	}
	let current = object
	for (let index = 0; index < path.length; index++) {
		if (current == null) {
			return defaultValue
		}
		if (isUnsafeProperty(path[index])) {
			return defaultValue
		}
		current = current[path[index]]
	}
	if (current === undefined) {
		return defaultValue
	}
	return current
}

export function get(data, path) {
	if (data == null) {
		return undefined
	}
	switch (typeof path) {
		case 'string': {
			if (isUnsafeProperty(path)) {
				return undefined
			}
			const result = data[path]
			if (result === undefined) {
				return isDeepKey(path) ? get(data, toPath(path)) : undefined
			}
			return result
		}
		case 'number':
		case 'symbol': {
			if (typeof path === 'number') {
				path = toKey(path)
			}
			const result = data[path]
			return result === undefined ? undefined : result
		}
		default: {
			if (Array.isArray(path)) {
				return getWithPath(data, path)
			}
			path = Object.is(path?.valueOf(), -0) ? '-0' : String(path)
			if (isUnsafeProperty(path)) {
				return undefined
			}
			const result = data[path]
			return result === undefined ? undefined : result
		}
	}
}

export function set(data, path, value) {
	updateWith(data, path, () => value, () => undefined)
}

function updateWith(obj, path, updater, customizer) {
	if (obj == null && !isObject(obj)) {
		return obj
	}

	let resolvedPath
	if (isKey(path, obj)) {
		resolvedPath = [path]
	}
	else if (Array.isArray(path)) {
		resolvedPath = path
	}
	else {
		resolvedPath = toPath(path)
	}

	const updateValue = updater(get(obj, resolvedPath))
	let current = obj
	for (let i = 0; i < resolvedPath.length && current != null; i++) {
		const key = toKey(resolvedPath[i])
		if (isUnsafeProperty(key)) {
			continue
		}
		let newValue
		if (i === resolvedPath.length - 1) {
			newValue = updateValue
		}
		else {
			const objValue = current[key]
			const customizerResult = customizer?.(objValue, key, obj)
			newValue = customizerResult !== undefined
				? customizerResult
				: isObject(objValue)
					? objValue
					: isIndex(resolvedPath[i + 1])
						? []
						: {}
		}
		assignValue(current, key, newValue)
		current = current[key]
	}
	return obj
}

function assignValue(object, key, value) {
	const objValue = object[key]
	if (!(hasOwn(object, key) && isEqualsSameValueZero(objValue, value)) || (value === undefined && !(key in object))) {
		object[key] = value
	}
}

export function uuid() {
	return Math.random().toString(36).slice(2, 7)
}

export function sleep(time) {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve()
		}, time)
	})
}

export function toCamelCase(attr) {
	return attr.toLowerCase().replace(/-(.)/g, (_, group) => {
		return group.toUpperCase()
	})
}

export function camelCaseToUnderscore(str) {
	return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * 通过 vnode 获取 data 属性
 * @param {*} attrs
 * @param {*} handler
 */
export function getDataAttributes(attrs, handler) {
	if (!attrs) {
		return
	}
	const result = {}
	for (const attr in attrs) {
		if (!attr.startsWith('data-')) {
			continue
		}
		const theAfter = attr.replace(/^data-/, '')
		const transAttr = toCamelCase(theAfter)
		result[transAttr] = handler(attrs[attr])
	}

	return result
}

const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined'

export const isAndroid = isBrowser && /Android/i.test(navigator.userAgent)

export const isIOS = isBrowser && /iPad|iPhone|iPod/.test(navigator.userAgent)

export const isHarmonyOS = isBrowser && /OpenHarmony|harmony/.test(navigator.userAgent)

export const isDesktop = isBrowser && !/Android|iPad|iPhone|iPod|OpenHarmony|harmony|Mobile/.test(navigator.userAgent)

export const isWebWorker = (() => {
	// eslint-disable-next-line no-undef
	if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
		// 代码在Web Worker内运行
		return true
	}
	else {
		return false
	}
})()

function resolvePath(basePath, relativePath) {
	// 如果相对路径以'/'开头，则将其视为根路径下的路径
	if (relativePath.startsWith('/')) {
		// 移除开头的'/'
		return relativePath.slice(1)
	}

	const currParts = basePath.split('/')
	const relativeParts = relativePath.split('/')

	for (const element of relativeParts) {
		const part = element
		if (part === '..') {
			// 向上级目录移动
			if (currParts.length > 0) {
				currParts.pop() // 移除最后一个部分（通常是当前目录）
			}
		}
		else if (part !== '.' && part !== '') {
			// 将相对路径部分添加到解析后的路径中
			currParts.push(part)
		}
	}
	return currParts.join('/')
}

export function parsePath(currPath, url) {
	// 处理路径问题
	const basePath = currPath.split('/').slice(0, -1).join('/')
	const parts = url.split('?')
	const pagePath = parts[0]
	const paramStr = parts[1]
	let newUrl = resolvePath(basePath, pagePath)
	if (paramStr) {
		newUrl += `?${paramStr}`
	}
	return newUrl
}

// TODO: 合并 compiler 下的 transformRpx
const rpxRegex = /([+-]?\d+(?:\.\d+)?)rpx/g
export function transformRpx(styleText) {
	if (!isString(styleText)) {
		return styleText
	}
	return styleText.replace(rpxRegex, (match, pixel) => {
		return `${Number(pixel)}rem`
	})
}

export function suffixPixel(value) {
	const isNumber = typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value)
	return isNumber ? `${value}px` : value
}

/**
 * 添加 Deg 后缀
 */
function suffixDegree(value) {
	return `${value}deg`
}

/**
 * 转化 animate 中 transform 的支持类型为 cssText 中的值
 */
const transformHandler = {
	matrix(args) {
		return `matrix(${args.join(', ')})`
	},
	matrix3d(args) {
		return `matrix3d(${args.join(', ')})`
	},
	rotate(args) {
		const [angle] = args.map(suffixDegree)
		return `rotate(${angle})`
	},
	rotate3d(args) {
		args[3] = suffixDegree(args[3])
		return `rotate3d(${args.join(', ')})`
	},
	rotateX(args) {
		const [angle] = args.map(suffixDegree)
		return `rotateX(${angle})`
	},
	rotateY(args) {
		const [angle] = args.map(suffixDegree)
		return `rotateY(${angle})`
	},
	rotateZ(args) {
		const [angle] = args.map(suffixDegree)
		return `rotateZ(${angle})`
	},
	scale(args) {
		return `scale(${args.join(', ')})`
	},
	scale3d(args) {
		return `scale3d(${args.join(', ')})`
	},
	scaleX(args) {
		return `scaleX(${args[0]})`
	},
	scaleY(args) {
		return `scaleY(${args[0]})`
	},
	scaleZ(args) {
		return `scaleZ(${args[0]})`
	},
	skew(args) {
		const _args = args.map(suffixDegree)
		return `skew(${_args.join(', ')})`
	},
	skewX(args) {
		const [angle] = args.map(suffixDegree)
		return `skewX(${angle})`
	},
	skewY(args) {
		const [angle] = args.map(suffixDegree)
		return `skewY(${angle})`
	},
	translate(args) {
		const _args = args.map(suffixPixel)
		return `translate(${_args.join(', ')})`
	},
	translate3d(args) {
		const _args = args.map(suffixPixel)
		return `translate3d(${_args.join(', ')})`
	},
	translateX(args) {
		const [value] = args.map(suffixPixel)
		return `translateX(${value})`
	},
	translateY(args) {
		const [value] = args.map(suffixPixel)
		return `translateY(${value})`
	},
	translateZ(args) {
		const [value] = args.map(suffixPixel)
		return `translateZ(${value})`
	},
}

export function animationToStyle(action) {
	const { animates, option } = action

	const transformOrigin = option.transformOrigin
	const transition = option.transition

	if (transformOrigin === undefined || transition === undefined) {
		return {
			transformOrigin: '',
			transform: '',
			transition: '',
		}
	}

	const transformAnimations = []
	const styles = {}
	for (let i = 0; i < animates.length; i++) {
		const animate = animates[i]

		if (animate.type === 'style') {
			// 处理样式属性
			const [prop, value] = animate.args
			styles[prop] = value
		}
		else {
			// 处理 transform
			const { type, args } = animate
			if (isFunction(transformHandler[type])) {
				transformAnimations.push(transformHandler[type](args))
			}
			else {
				console.warn(`[Common] SDK inner warning (Transform Handler not found animation type: ${type})`)
			}
		}
	}

	return {
		keyframes: [
			{
				transform: transformAnimations.join(' '),
				transformOrigin,
				...styles,
			},
		],
		options: {
			duration: transition.duration,
			easing: transition.timingFunction,
			delay: transition.delay,
			fill: 'forwards', // 保持动画最后一帧的状态
		},
	}
}

/**
 * 高效的深拷贝实现
 * @param {*} value - 要拷贝的值
 * @returns {*} 拷贝后的值
 */
export function cloneDeep(value) {
	// 处理原始类型和函数
	if (value === null || typeof value !== 'object') {
		return value
	}

	// 使用 WeakMap 处理循环引用
	const seen = new WeakMap()

	function clone(item) {
		// 处理原始类型和函数
		if (item === null || typeof item !== 'object') {
			return item
		}

		// 处理日期对象
		if (item instanceof Date) {
			return new Date(item)
		}

		// 处理正则表达式
		if (item instanceof RegExp) {
			return new RegExp(item.source, item.flags)
		}

		// 处理数组
		if (Array.isArray(item)) {
			if (seen.has(item)) {
				return seen.get(item)
			}
			const arr = []
			seen.set(item, arr)
			arr.push(...item.map(clone))
			return arr
		}

		// 处理普通对象
		if (seen.has(item)) {
			return seen.get(item)
		}

		const obj = Object.create(Object.getPrototypeOf(item))
		seen.set(item, obj)

		return Object.assign(obj, ...Object.keys(item).map(key => ({
			[key]: clone(item[key]),
		})))
	}

	return clone(value)
}
