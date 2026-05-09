import { camelCaseToUnderscore, parsePath } from '@dimina/common'

export function getActualBottom(element, includeHeight) {
	if (!element) {
		return 0
	}
	const rect = element.getBoundingClientRect()

	// 考虑视口缩放
	const visualViewport = window.visualViewport
	const viewportHeight = visualViewport ? visualViewport.height : window.innerHeight

	return viewportHeight - rect.bottom - (includeHeight ? rect.height : 0)
}

export function withInstall(comp) {
	const name = camelCaseToUnderscore(comp.__name)
	comp.__tagName = name
	comp.install = (app) => {
		install(app, comp)
	}
	return comp
}

const componentPrefix = 'dd-'
export function install(app, component) {
	app.component(
		componentPrefix + component.__tagName,
		component,
	)
}

export function deepToRaw(obj) {
	if (typeof obj !== 'object' || obj === null) {
		return obj // 如果不是对象或数组，直接返回
	}
	if (Array.isArray(obj)) {
		return obj.map(item => deepToRaw(item)) // 如果是数组，递归处理每个元素
	}
	const result = {}
	for (const key in obj) {
		if (Object.hasOwn(obj, key)) {
			const value = obj[key]
			if (isRef(value)) {
				result[key] = unref(value)
			}
			else if (isReactive(value)) {
				result[key] = toRaw(value)
			}
			else if (typeof value === 'object' && value !== null) {
				result[key] = deepToRaw(value) // 如果是对象或数组，递归处理
			}
			else {
				result[key] = value
			}
		}
	}
	return result
}

export function replaceExternalClassTokens(className, externalClass, replacementClassName) {
	const classTokens = className.split(/\s+/).filter(Boolean)
	const replacementTokens = replacementClassName.split(/\s+/).filter(Boolean)
	const nextClassTokens = []

	for (const token of classTokens) {
		if (token === externalClass) {
			nextClassTokens.push(...replacementTokens)
		}
		else {
			nextClassTokens.push(token)
		}
	}

	return [...new Set(nextClassTokens)].join(' ')
}

export { parsePath }
