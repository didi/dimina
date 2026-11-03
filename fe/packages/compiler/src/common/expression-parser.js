/**
 * 表达式解析器 - 使用 Oxc AST 解析器提取依赖
 */

import { parseSync } from 'oxc-parser'

// JavaScript 关键字和全局对象，不应该被识别为数据依赖
const KEYWORDS = new Set([
	'true', 'false', 'null', 'undefined',
	'NaN', 'Infinity',
	'this', 'arguments',
	'Array', 'Object', 'String', 'Number', 'Boolean',
	'Math', 'Date', 'RegExp', 'Error',
	'JSON', 'console', 'window', 'document',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite',
	'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent'
])

/**
 * 提取表达式中的所有变量依赖路径
 * 使用 Oxc AST 解析器进行精确分析
 * @param {string} expression - 表达式字符串，如 "count || defaultValue" 或 "item.name"
 * @returns {Array<string>} - 依赖的变量名数组，如 ["count", "defaultValue"] 或 ["item"]
 */
export function extractDependencies(expression, paths = false) {
	if (!expression || typeof expression !== 'string') {
		return []
	}

	const dependencies = new Set()

	try {
		// 将表达式包装为完整的语句以便 Oxc 解析
		const code = `(${expression})`
		const ast = parseSync('expression.js', code, {
			sourceType: 'module',
			lang: 'js',
		}).program

		visitExpressionAst(ast, null, dependencies, paths, code)
	} catch (error) {
		// AST 解析失败时回退到空数组
		console.warn('[expression-parser] AST 解析失败，表达式:', expression, '错误:', error.message)
		return []
	}

	return paths ? Array.from(dependencies, path => JSON.parse(path)) : Array.from(dependencies)
}

function staticMemberPath(node) {
	if (node.type === 'Identifier') return KEYWORDS.has(node.name) ? null : [node.name]
	if (node.type === 'ChainExpression') return staticMemberPath(node.expression)
	if (node.type !== 'MemberExpression') return null
	const path = staticMemberPath(node.object)
	if (!path) return null
	const key = node.computed ? node.property.value : node.property.name
	return typeof key === 'string' || typeof key === 'number' ? [...path, key] : null
}

function runtimeMemberPath(node, source, visitKey) {
	if (node.type === 'Identifier') return KEYWORDS.has(node.name) ? null : [JSON.stringify(node.name)]
	if (node.type === 'ChainExpression') return runtimeMemberPath(node.expression, source, visitKey)
	if (node.type !== 'MemberExpression') return null
	const path = runtimeMemberPath(node.object, source, visitKey)
	if (!path) return null
	if (!node.computed) return [...path, JSON.stringify(node.property.name)]
	visitKey(node.property)
	return [...path, source.slice(node.property.start, node.property.end)]
}

function visitExpressionAst(node, parent, dependencies, paths, source) {
	if (!node || typeof node !== 'object') {
		return
	}

	if (node.type === 'Identifier') {
		collectIdentifier(node, parent, dependencies, paths, source)
		return
	}

	// 处理成员表达式，确保只提取根对象，并跳过子节点避免重复处理属性名
	if (node.type === 'MemberExpression') {
		if (paths) {
			const path = paths === 'runtime'
				? runtimeMemberPath(node, source, key => visitExpressionAst(key, node, dependencies, paths, source))
				: staticMemberPath(node)
			if (path) {
				dependencies.add(JSON.stringify(path))
			}
			else {
				visitExpressionAst(node.object, node, dependencies, paths, source)
				if (node.computed) visitExpressionAst(node.property, node, dependencies, paths, source)
			}
			return
		}
		let root = node.object
		while (root?.type === 'MemberExpression' || root?.type === 'ChainExpression') {
			root = root.type === 'ChainExpression' ? root.expression : root.object
		}

		if (root?.type === 'Identifier' && !KEYWORDS.has(root.name)) {
			dependencies.add(root.name)
		}
		return
	}

	for (const [key, value] of Object.entries(node)) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') {
			continue
		}

		if (Array.isArray(value)) {
			for (const child of value) {
				visitExpressionAst(child, node, dependencies, paths, source)
			}
		}
		else {
			visitExpressionAst(value, node, dependencies, paths, source)
		}
	}
}

function collectIdentifier(node, parent, dependencies, paths) {
	const name = node.name

	// 跳过关键字和全局对象
	if (KEYWORDS.has(name)) {
		return
	}

	// 如果是 obj.prop，我们只要 obj，不要 prop
	if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) {
		return
	}

	// 对象字面量的非计算 key 是静态属性名，不是数据依赖
	if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) {
		return
	}

	dependencies.add(paths ? JSON.stringify([paths === 'runtime' ? JSON.stringify(name) : name]) : name)
}

/**
 * 解析表达式并生成依赖路径信息
 * @param {string} expression - 表达式字符串
 * @returns {Object} - { expression: 原始表达式, dependencies: 依赖数组, isSimple: 是否简单绑定 }
 */
export function parseExpression(expression) {
	if (!expression || typeof expression !== 'string') {
		return {
			expression: '',
			dependencies: [],
			isSimple: true
		}
	}

	const dependencies = extractDependencies(expression)

	// 判断是否为简单绑定（单个变量，无运算符）
	// 简单绑定：count, item, data
	// 复杂绑定：count + 1, item.name, count || defaultValue
	const isSimple = dependencies.length === 1 && expression.trim() === dependencies[0]

	return {
		expression: expression.trim(),
		dependencies,
		isSimple
	}
}

/**
 * 解析成员访问表达式，提取根对象和路径
 * @param {string} expression - 表达式字符串，如 "item.name" 或 "data[0].value"
 * @returns {Object} - { root: 根对象, path: 完整路径 }
 */
export function parseMemberExpression(expression) {
	if (!expression || typeof expression !== 'string') {
		return { root: null, path: null }
	}

	expression = expression.trim()

	// 提取第一个标识符作为根对象
	const rootMatch = expression.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/)
	if (!rootMatch) {
		return { root: null, path: null }
	}

	const root = rootMatch[1]

	// 如果表达式就是根对象本身，返回
	if (expression === root) {
		return { root, path: root }
	}

	// 否则返回完整路径
	return { root, path: expression }
}

/**
 * 检查表达式是否包含某个依赖
 * @param {string} expression - 表达式字符串
 * @param {string} dependency - 要检查的依赖变量名
 * @returns {boolean} 如果表达式包含该依赖则返回 true，否则返回 false
 */
export function hasDependency(expression, dependency) {
	const deps = extractDependencies(expression)
	return deps.includes(dependency)
}

/**
 * 批量解析多个属性绑定表达式
 * @param {Object} bindings - 绑定对象，如 { count2: "count", value: "item.name" }
 * @returns {Object} - 解析后的绑定信息
 */
export function parseBindings(bindings) {
	if (!bindings || typeof bindings !== 'object') {
		return {}
	}

	const parsed = {}

	for (const [propName, expression] of Object.entries(bindings)) {
		const source = typeof expression === 'string' ? expression.trim() : ''
		const dependencyPaths = extractDependencies(source, true)
		const dependencies = [...new Set(dependencyPaths.map(path => path[0]))]
		parsed[propName] = {
			expression: source,
			dependencies,
			isSimple: !source || (dependencies.length === 1 && source === dependencies[0]),
			dependencyPaths,
		}
	}

	return parsed
}
