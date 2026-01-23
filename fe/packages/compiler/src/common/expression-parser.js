/**
 * 表达式解析器 - 使用 Oxc AST 解析器提取依赖
 */

import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'

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
export function extractDependencies(expression) {
	if (!expression || typeof expression !== 'string') {
		return []
	}

	const dependencies = new Set()
	
	try {
		// 将表达式包装为完整的语句以便 Oxc 解析
		const code = `(${expression})`
		const ast = parseSync('expression.js', code, {
			sourceType: 'module'
		})
		
		// 用于追踪 MemberExpression 是否已被处理
		const processedMemberExpressions = new Set()
		
		// 遍历 AST 提取标识符
		walk(ast.program, {
			enter(node, parent) {
				// 处理成员表达式，确保只提取根对象
				if (node.type === 'MemberExpression') {
					// 避免重复处理
					if (processedMemberExpressions.has(node)) {
						return
					}
					processedMemberExpressions.add(node)
					
					// 获取成员表达式的根对象
					let root = node.object
					while (root.type === 'MemberExpression') {
						root = root.object
						processedMemberExpressions.add(root)
					}
					
					// 如果根对象是标识符且不是关键字，添加为依赖
					if (root.type === 'Identifier' && !KEYWORDS.has(root.name)) {
						dependencies.add(root.name)
					}
					
					return
				}
				
				// 处理标识符
				if (node.type === 'Identifier') {
					const name = node.name
					
					// 跳过关键字和全局对象
					if (KEYWORDS.has(name)) {
						return
					}
					
					// 检查是否是对象属性（右侧）
					// 如果是 obj.prop，我们只要 obj，不要 prop
					if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
						// 这是属性名（非计算属性），跳过
						return
					}
					
					// 检查是否是对象字面量的键
					if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) {
						// 这是对象字面量的键，跳过
						return
					}
					
					// 如果父节点是 MemberExpression 的 object 部分，已经在上面的 MemberExpression 处理中处理过了
					if (parent && parent.type === 'MemberExpression' && parent.object === node) {
						// 这个会被 MemberExpression 处理，跳过
						return
					}
					
					// 其他情况下，如果不是属性名，就是我们需要的依赖
					dependencies.add(name)
				}
			}
		})
	} catch (error) {
		// AST 解析失败时回退到空数组
		console.warn('[expression-parser] AST 解析失败，表达式:', expression, '错误:', error.message)
		return []
	}
	
	return Array.from(dependencies)
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
		parsed[propName] = parseExpression(expression)
	}
	
	return parsed
}

