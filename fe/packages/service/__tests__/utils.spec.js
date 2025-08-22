import { describe, expect, it, vi } from 'vitest'
import { filterInvokeObserver, mergeBehaviors } from '../src/core/utils'

describe('数据监听器触发匹配逻辑', () => {
	const funAB = vi.fn((numberA, numberB) => {
		return numberA + numberB
	})

	const funB = vi.fn((numberB) => {
		return numberB
	})

	const data = { numberA: 1, numberB: 2 }
	const observers = {
		'numberA, numberB': funAB,
		'numberB': funB,
	}

	Object.keys(data).forEach((key) => {
		filterInvokeObserver(key, observers, data)
	})

	it('执行函数B', () => {
		expect(funB).toHaveReturnedWith(2)
	})

	it('执行函数AB', () => {
		expect(funAB).toHaveReturnedWith(3)
	})

	const data2 = {
		some: {
			subfield: 6,
		},
		arr: Array.from({ length: 14 }).fill(8),
	}

	const funSubfield = vi.fn((subfield) => {
		// 1.设置 some.subfield 时触发
		// 2.设置 some 也会触发
		return subfield === data2.some.subfield
	})

	const funArr12 = vi.fn((arr12) => {
		// 1.设置 arr[12] 时触发
		return arr12 === data2.arr[12]
	})

	const funArr = vi.fn((arr) => {
		// 2.设置 arr 也会触发
		return arr === data2.arr
	})

	const observers2 = {
		'some.subfield': funSubfield,
		'arr[12]': funArr12,
		'arr': funArr,
	}

	const keys = ['some.subfield', 'arr[12]']
	keys.forEach((key) => {
		filterInvokeObserver(key, observers2, data2)
	})

	it('监听子数据字段', () => {
		expect(funSubfield).toHaveReturnedWith(true)
	})

	it('监听子数据数组中某个字段', () => {
		expect(funArr12).toHaveReturnedWith(true)
	})

	it('监听子数据数组字段', () => {
		expect(funArr).toHaveReturnedWith(true)
	})

	it('监听所有子数据字段的变化', () => {
		const data = {
			some: {
				field: 10,
			},
		}

		const funSubfield = vi.fn((field) => {
			return field === data.some.field
		})
		const observers = {
			'some.field.**': funSubfield,
		}
		filterInvokeObserver('some.field', observers, data)
		filterInvokeObserver('some.field.sub', observers, data)
		filterInvokeObserver('some', observers, data)
		expect(funSubfield).toHaveNthReturnedWith(1, true)
		expect(funSubfield).toHaveNthReturnedWith(2, true)
		expect(funSubfield).toHaveNthReturnedWith(3, true)
	})

	it('监听全部', () => {
		const data = {
			a: 1,
			b: 2,
			c: 3,
		}

		const funAll = vi.fn((res) => {
			return data === res
		})
		const observers = {
			'**': funAll,
		}

		filterInvokeObserver('b', observers, data)
		expect(funAll).toHaveReturnedWith(true)
	})
})

describe('mergeBehaviors 行为合并逻辑', () => {
	it('合并基本属性', () => {
		const target = {
			properties: {
				prop1: String,
			},
			data: {
				data1: 'target',
			},
			methods: {
				method1: () => 'target',
			},
		}

		const behavior = {
			properties: {
				prop2: Number,
			},
			data: {
				data2: 'behavior',
			},
			methods: {
				method2: () => 'behavior',
			},
		}

		mergeBehaviors(target, [behavior])

		expect(target.properties).toEqual({
			prop2: Number,
			prop1: String,
		})
		expect(target.data).toEqual({
			data2: 'behavior',
			data1: 'target',
		})
		expect(target.methods).toEqual({
			method2: expect.any(Function),
			method1: expect.any(Function),
		})
	})

	it('target 属性优先级高于 behavior', () => {
		const target = {
			properties: {
				prop1: String,
			},
			data: {
				data1: 'target',
			},
			methods: {
				method1: () => 'target',
			},
		}

		const behavior = {
			properties: {
				prop1: Number, // 同名属性
			},
			data: {
				data1: 'behavior', // 同名数据
			},
			methods: {
				method1: () => 'behavior', // 同名方法
			},
		}

		mergeBehaviors(target, [behavior])

		expect(target.properties.prop1).toBe(String)
		expect(target.data.data1).toBe('target')
		expect(target.methods.method1()).toBe('target')
	})

	it('合并生命周期函数', () => {
		const target = {
			created: () => 'target-created',
		}

		const behavior = {
			created: () => 'behavior-created',
			attached: () => 'behavior-attached',
		}

		mergeBehaviors(target, [behavior])

		expect(target.behaviorLifetimes).toBeDefined()
		expect(target.behaviorLifetimes.created).toHaveLength(1)
		expect(target.behaviorLifetimes.attached).toHaveLength(1)
		expect(target.behaviorLifetimes.created[0]()).toBe('behavior-created')
		expect(target.behaviorLifetimes.attached[0]()).toBe('behavior-attached')
	})

	it('递归合并嵌套 behaviors', () => {
		const nestedBehavior = {
			properties: {
				nestedProp: Boolean,
			},
			data: {
				nestedData: 'nested',
			},
		}

		const behavior = {
			behaviors: [nestedBehavior],
			properties: {
				prop1: String,
			},
		}

		const target = {
			properties: {
				targetProp: Number,
			},
		}

		mergeBehaviors(target, [behavior])

		expect(target.properties).toEqual({
			nestedProp: Boolean,
			prop1: String,
			targetProp: Number,
		})
		expect(target.data).toEqual({
			nestedData: 'nested',
		})
	})

	it('处理多个 behaviors', () => {
		const behavior1 = {
			properties: {
				prop1: String,
			},
			data: {
				data1: 'behavior1',
			},
		}

		const behavior2 = {
			properties: {
				prop2: Number,
			},
			data: {
				data2: 'behavior2',
			},
		}

		const target = {
			properties: {
				targetProp: Boolean,
			},
		}

		mergeBehaviors(target, [behavior1, behavior2])

		expect(target.properties).toEqual({
			prop1: String,
			prop2: Number,
			targetProp: Boolean,
		})
		expect(target.data).toEqual({
			data1: 'behavior1',
			data2: 'behavior2',
		})
	})

	it('处理无效的 behaviors 参数', () => {
		const target = {
			properties: {
				prop1: String,
			},
		}

		// 测试 null
		mergeBehaviors(target, null)
		expect(target.properties.prop1).toBe(String)

		// 测试 undefined
		mergeBehaviors(target, undefined)
		expect(target.properties.prop1).toBe(String)

		// 测试非数组
		mergeBehaviors(target, 'not-array')
		expect(target.properties.prop1).toBe(String)
	})

	it('处理无效的 behavior 对象', () => {
		const target = {
			properties: {
				prop1: String,
			},
		}

		const invalidBehaviors = [
			null,
			undefined,
			'string',
			123,
			true,
		]

		mergeBehaviors(target, invalidBehaviors)

		// target 应该保持不变
		expect(target.properties).toEqual({
			prop1: String,
		})
	})

	it('避免重复处理同一个 behavior 对象', () => {
		const sharedBehavior = {
			data: {
				shared: 'value',
			},
		}

		const behavior1 = {
			behaviors: [sharedBehavior],
			data: {
				data1: 'behavior1',
			},
		}

		const behavior2 = {
			behaviors: [sharedBehavior],
			data: {
				data2: 'behavior2',
			},
		}

		const target = {}

		mergeBehaviors(target, [behavior1, behavior2])

		// shared behavior 应该只被处理一次
		expect(target.data).toEqual({
			shared: 'value',
			data1: 'behavior1',
			data2: 'behavior2',
		})
	})

	it('合并所有生命周期函数', () => {
		const behavior1 = {
			created: () => 'behavior1-created',
			attached: () => 'behavior1-attached',
		}

		const behavior2 = {
			created: () => 'behavior2-created',
			ready: () => 'behavior2-ready',
			detached: () => 'behavior2-detached',
		}

		const target = {}

		mergeBehaviors(target, [behavior1, behavior2])

		expect(target.behaviorLifetimes.created).toHaveLength(2)
		expect(target.behaviorLifetimes.attached).toHaveLength(1)
		expect(target.behaviorLifetimes.ready).toHaveLength(1)
		expect(target.behaviorLifetimes.detached).toHaveLength(1)

		expect(target.behaviorLifetimes.created[0]()).toBe('behavior1-created')
		expect(target.behaviorLifetimes.created[1]()).toBe('behavior2-created')
		expect(target.behaviorLifetimes.attached[0]()).toBe('behavior1-attached')
		expect(target.behaviorLifetimes.ready[0]()).toBe('behavior2-ready')
		expect(target.behaviorLifetimes.detached[0]()).toBe('behavior2-detached')
	})
})

describe('观察者函数 oldVal 参数测试', () => {
	it('应该将 oldVal 参数传递给单个字段观察器', () => {
		const observer = vi.fn()
		const observers = {
			'numberA': observer,
		}
		const data = { numberA: 10 }
		const oldVal = 5
		const ctx = {}

		filterInvokeObserver('numberA', observers, data, ctx, oldVal)

		expect(observer).toHaveBeenCalledWith(10, 5)
	})

	it('应该将 oldVal 参数传递给完全匹配的字段观察器', () => {
		const observer = vi.fn()
		const observers = {
			'user.name': observer,
		}
		const data = { user: { name: 'John' } }
		const oldVal = 'Jane'
		const ctx = {}

		filterInvokeObserver('user.name', observers, data, ctx, oldVal)

		expect(observer).toHaveBeenCalledWith('John', 'Jane')
	})

	it('多字段观察器不应该接收 oldVal 参数', () => {
		const observer = vi.fn()
		const observers = {
			'numberA, numberB': observer,
		}
		const data = { numberA: 10, numberB: 20 }
		const oldVal = 5
		const ctx = {}

		filterInvokeObserver('numberA', observers, data, ctx, oldVal)

		expect(observer).toHaveBeenCalledWith(10, 20)
		expect(observer).not.toHaveBeenCalledWith(10, 20, 5)
	})
})
