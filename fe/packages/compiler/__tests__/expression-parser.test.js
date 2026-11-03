/**
 * 表达式解析器测试
 */

import { describe, expect, it } from 'vitest'
import {
	extractDependencies,
	parseExpression,
	parseMemberExpression,
	hasDependency,
	parseBindings
} from '../src/common/expression-parser.js'

describe('expression-parser', () => {
	describe('extractDependencies', () => {
		it('应该提取简单变量', () => {
			expect(extractDependencies('count')).toEqual(['count'])
			expect(extractDependencies('userName')).toEqual(['userName'])
			expect(extractDependencies('_privateVar')).toEqual(['_privateVar'])
		})

		it('应该提取复杂表达式中的所有变量', () => {
			expect(extractDependencies('count + 1')).toEqual(['count'])
			expect(extractDependencies('count || defaultValue')).toEqual(['count', 'defaultValue'])
			expect(extractDependencies('a && b || c')).toEqual(['a', 'b', 'c'])
		})

	it('应该提取成员访问表达式的根对象', () => {
		expect(extractDependencies('item.name')).toEqual(['item'])
		expect(extractDependencies('data.user.name')).toEqual(['data'])
	})

		it('应该提取三元表达式中的变量', () => {
			expect(extractDependencies('active ? "yes" : "no"')).toEqual(['active'])
			expect(extractDependencies('count > 0 ? count : defaultValue')).toEqual(['count', 'defaultValue'])
		})

		it('应该忽略关键字和字面量', () => {
			expect(extractDependencies('true')).toEqual([])
			expect(extractDependencies('false')).toEqual([])
			expect(extractDependencies('null')).toEqual([])
			expect(extractDependencies('undefined')).toEqual([])
		})

	it('应该处理函数调用', () => {
		expect(extractDependencies('formatDate(date)')).toEqual(['formatDate', 'date'])
		// Math 是全局对象，不需要追踪；只追踪参数 a 和 b
		expect(extractDependencies('Math.max(a, b)')).toEqual(['a', 'b'])
	})

	it('应该处理数组和对象字面量', () => {
		expect(extractDependencies('[a, b, c]')).toEqual(['a', 'b', 'c'])
		// 对象字面量的键是静态属性名，不是数据依赖；只追踪值部分
		expect(extractDependencies('{ name: userName, age: userAge }')).toEqual(['userName', 'userAge'])
	})

		it('应该处理空值和无效输入', () => {
			expect(extractDependencies('')).toEqual([])
			expect(extractDependencies(null)).toEqual([])
			expect(extractDependencies(undefined)).toEqual([])
		})
	})

	describe('parseExpression', () => {
		it('应该识别简单绑定', () => {
			const result = parseExpression('count')
			expect(result.expression).toBe('count')
			expect(result.dependencies).toEqual(['count'])
			expect(result.isSimple).toBe(true)
		})

		it('应该识别复杂表达式', () => {
			const result = parseExpression('count + 1')
			expect(result.expression).toBe('count + 1')
			expect(result.dependencies).toEqual(['count'])
			expect(result.isSimple).toBe(false)
		})

		it('应该处理逻辑运算符', () => {
			const result = parseExpression('count || defaultValue')
			expect(result.expression).toBe('count || defaultValue')
			expect(result.dependencies).toEqual(['count', 'defaultValue'])
			expect(result.isSimple).toBe(false)
		})

		it('应该处理成员访问', () => {
			const result = parseExpression('item.name')
			expect(result.expression).toBe('item.name')
			expect(result.dependencies).toEqual(['item'])
			expect(result.isSimple).toBe(false)
		})
	})

	describe('parseMemberExpression', () => {
		it('应该解析成员访问表达式', () => {
			const result = parseMemberExpression('item.name')
			expect(result.root).toBe('item')
			expect(result.path).toBe('item.name')
		})

		it('应该处理深层嵌套', () => {
			const result = parseMemberExpression('data.user.profile.name')
			expect(result.root).toBe('data')
			expect(result.path).toBe('data.user.profile.name')
		})

		it('应该处理单个变量', () => {
			const result = parseMemberExpression('count')
			expect(result.root).toBe('count')
			expect(result.path).toBe('count')
		})

		it('应该处理无效输入', () => {
			const result = parseMemberExpression('')
			expect(result.root).toBeNull()
			expect(result.path).toBeNull()
		})
	})

	describe('hasDependency', () => {
		it('应该检测简单依赖', () => {
			expect(hasDependency('count', 'count')).toBe(true)
			expect(hasDependency('count', 'other')).toBe(false)
		})

		it('应该检测复杂表达式中的依赖', () => {
			expect(hasDependency('count || defaultValue', 'count')).toBe(true)
			expect(hasDependency('count || defaultValue', 'defaultValue')).toBe(true)
			expect(hasDependency('count || defaultValue', 'other')).toBe(false)
		})

	it('应该检测成员访问中的依赖', () => {
		expect(hasDependency('item.name', 'item')).toBe(true)
		// name 是 item 的属性，不是独立的依赖
		expect(hasDependency('item.name', 'name')).toBe(false)
	})
	})

	describe('parseBindings', () => {
		it('应该解析多个绑定', () => {
			const bindings = {
				count2: 'count',
				value: 'item.name',
				parity: 'items[0].count % 2',
				total: 'count + defaultValue'
			}
			const result = parseBindings(bindings)
			
			expect(result.count2.expression).toBe('count')
			expect(result.count2.isSimple).toBe(true)
			
			expect(result.value.expression).toBe('item.name')
			expect(result.value.isSimple).toBe(false)
			expect(result.value.dependencyPaths).toEqual([['item', 'name']])
			expect(result.parity.dependencyPaths).toEqual([['items', 0, 'count']])
			
			expect(result.total.expression).toBe('count + defaultValue')
			expect(result.total.dependencies).toEqual(['count', 'defaultValue'])
			expect(result.total.isSimple).toBe(false)
		})

		it('应该处理空输入', () => {
			expect(parseBindings(null)).toEqual({})
			expect(parseBindings({})).toEqual({})
		})
	})

	describe('vant 组件真实场景测试', () => {
		it('应该处理 checkbox 组件的 value 绑定', () => {
			const result = parseExpression('checkbox1')
			expect(result.dependencies).toEqual(['checkbox1'])
			expect(result.isSimple).toBe(true)
		})

		it('应该处理条件表达式绑定', () => {
			const result = parseExpression('checkbox3 ? activeIcon : inactiveIcon')
			expect(result.dependencies).toEqual(['checkbox3', 'activeIcon', 'inactiveIcon'])
			expect(result.isSimple).toBe(false)
		})

		it('应该处理数组元素绑定', () => {
			const result = parseExpression('list[0]')
			expect(result.dependencies).toEqual(['list'])
			expect(result.isSimple).toBe(false)
		})

		it('应该处理布尔字面量', () => {
			const result = parseExpression('false')
			expect(result.dependencies).toEqual([])
			expect(result.isSimple).toBe(false)
		})
	})
})

