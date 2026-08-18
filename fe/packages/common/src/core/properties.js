import { cloneDeep } from './utils'

const SUPPORTED_PROPERTY_TYPES = new Set([
	String,
	Number,
	Boolean,
	Object,
	Array,
	null,
])

function isPropertyType(type) {
	return SUPPORTED_PROPERTY_TYPES.has(type)
}

function getImplicitDefault(type) {
	if (type === String) return ''
	if (type === Number) return 0
	if (type === Boolean) return false
	if (type === Array) return []
	return null
}

function normalizeOptionalTypes(optionalTypes) {
	if (!Array.isArray(optionalTypes)) {
		return []
	}
	return optionalTypes.filter(isPropertyType)
}

/**
 * 将小程序 properties 的简写/完整声明统一成可跨线程传输的语义结构。
 * 微信在声明阶段会为未显式提供 value 的属性按主类型补默认值。
 */
export function normalizePropertyDefinition(definition) {
	let type
	let optionalTypes = []
	let value

	if (isPropertyType(definition)) {
		type = definition
	}
	else if (definition && typeof definition === 'object') {
		type = definition.type
		optionalTypes = normalizeOptionalTypes(definition.optionalTypes)
		value = definition.value
	}

	if (!isPropertyType(type)) {
		type = optionalTypes[0] ?? null
	}

	if (value === undefined) {
		value = getImplicitDefault(type)
	}

	return {
		type,
		optionalTypes,
		value: cloneDeep(value),
	}
}

function isExparserArray(value) {
	// Dimina 的 service/container/render 分属不同 realm。数组经过桥接后仍是数组，
	// 但不一定满足当前 render realm 的 `instanceof Array`。
	// 主类型 Array 使用 Array.isArray：它既能识别跨 realm 数组，也保留
	// exparser 接受 Array 子类的转换语义。
	return Array.isArray(value)
}

function isPlainArray(value) {
	// optionalTypes 的 Array 匹配比主类型严格：普通数组可命中，Array 子类不可命中。
	// 这里复用跨 realm 安全的基础数组判断，再用原生构造器名称排除 Array 子类；
	// 因此不能直接把主类型和 optionalTypes 合并为同一种判断语义。
	return isExparserArray(value) && value?.constructor?.name === Array.name
}

/**
 * optionalTypes 只做严格类型匹配；命中后保持调用方传入值，不执行主类型转换。
 */
export function matchesPropertyType(type, value) {
	if (type === String) return typeof value === 'string'
	if (type === Number) return Number.isFinite(value)
	if (type === Boolean) return typeof value === 'boolean'
	if (type === Object) return value !== null && value?.constructor === Object
	if (type === Array) return isPlainArray(value)
	return value !== undefined
}

function warnTypeConversion(warn, message) {
	if (typeof warn === 'function') {
		warn(message)
	}
}

/**
 * 对齐微信 exparser 的 property convertValueToType 行为。
 * absent=true 表示模板没有传入该属性，此时使用组件声明的默认值。
 */
export function resolvePropertyValue(schema, value, { absent = false, warn } = {}) {
	if (absent) {
		return cloneDeep(schema.value)
	}

	for (const optionalType of schema.optionalTypes || []) {
		if (matchesPropertyType(optionalType, value)) {
			return value
		}
	}

	const type = schema.type
	if (type === String) {
		if (value === null || value === undefined) {
			warnTypeConversion(warn, 'property received type-uncompatible value: expected <String> but get null value. Used empty string instead.')
			return ''
		}
		if (typeof value === 'object') {
			warnTypeConversion(warn, 'property received type-uncompatible value: expected <String> but got object-typed value. Forcely converted.')
		}
		return String(value)
	}

	if (type === Number) {
		try {
			if (Number.isFinite(Number(value))) {
				return Number(value)
			}
		}
		catch {
			// Symbol 等值无法执行 Number 转换，按微信规则回退为 0。
		}
		const detail = typeof value === 'number'
			? 'got NaN or Infinity'
			: 'got non-number value'
		warnTypeConversion(warn, `property received type-uncompatible value: expected <Number> but ${detail}. Used 0 instead.`)
		return 0
	}

	if (type === Boolean) {
		return !!value
	}

	if (type === Array) {
		if (isExparserArray(value)) {
			return value
		}
		warnTypeConversion(warn, 'property received type-uncompatible value: expected <Array> but got non-array value. Used empty array instead.')
		return []
	}

	if (type === Object) {
		if (typeof value === 'object') {
			return value
		}
		warnTypeConversion(warn, 'property received type-uncompatible value: expected <Object> but got non-object value. Used null instead.')
		return null
	}

	if (value === undefined) {
		return null
	}
	return value
}

export function normalizePropertyValues(schemas, values = {}, { isAbsent, warn } = {}) {
	const normalized = {}
	for (const [name, schema] of Object.entries(schemas || {})) {
		const absent = typeof isAbsent === 'function'
			? isAbsent(name)
			: !Object.prototype.hasOwnProperty.call(values, name)
		normalized[name] = resolvePropertyValue(schema, values[name], { absent, warn })
	}
	return normalized
}
