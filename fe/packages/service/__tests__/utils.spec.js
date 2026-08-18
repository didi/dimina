import { describe, expect, it, vi } from 'vitest'
import { filterData, filterInvokeObserver, mergeBehaviors, syncUpdateChildrenProps } from '../src/core/utils'

describe('data initialization', () => {
	it('preserves function references at every nesting level', () => {
		const fn = vi.fn()
		const data = filterData({
			fn,
			nested: { fn },
			list: [fn, { fn }, [fn]],
		})

		expect(data.fn).toBe(fn)
		expect(data.nested.fn).toBe(fn)
		expect(data.list[0]).toBe(fn)
		expect(data.list[1].fn).toBe(fn)
		expect(data.list[2]).toEqual([fn])
	})
})

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
		// 精确监听 arr 不应被 arr[12] 的子路径赋值触发
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

	it('精确监听器不监听子数据数组字段', () => {
		expect(funArr).not.toHaveBeenCalled()
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

	it('按 exparser 的祖先顺序处理同名字段优先级', () => {
		const nestedBehavior = {
			properties: {
				behaviorOnly: String,
				componentWins: String,
			},
			data: {
				config: { nested: true, winner: 'nested' },
			},
			methods: {
				behaviorOnly: () => 'nested',
				componentWins: () => 'nested',
			},
			relations: {
				'./behavior-only': { type: 'parent', source: 'nested' },
				'./component-wins': { type: 'parent', source: 'nested' },
			},
			export: () => 'nested',
		}
		const firstBehavior = {
			behaviors: [nestedBehavior],
			properties: { behaviorOnly: Number, componentWins: Number },
			data: { config: { first: true, winner: 'first' } },
			methods: {
				behaviorOnly: () => 'first',
				componentWins: () => 'first',
			},
			relations: {
				'./behavior-only': { type: 'parent', source: 'first' },
				'./component-wins': { type: 'parent', source: 'first' },
			},
			export: () => 'first',
		}
		const secondBehavior = {
			properties: { behaviorOnly: Boolean, componentWins: Boolean },
			data: { config: { second: true, winner: 'second' } },
			methods: {
				behaviorOnly: () => 'second',
				componentWins: () => 'second',
			},
			relations: {
				'./behavior-only': { type: 'parent', source: 'second' },
				'./component-wins': { type: 'parent', source: 'second' },
			},
			export: () => 'second',
		}
		const target = {
			properties: { componentWins: Array },
			data: { config: { component: true, winner: 'component' } },
			methods: { componentWins: () => 'component' },
			relations: {
				'./component-wins': { type: 'parent', source: 'component' },
			},
			export: () => 'component',
		}

		mergeBehaviors(target, [firstBehavior, secondBehavior])

		expect(target.properties).toEqual({
			behaviorOnly: Boolean,
			componentWins: Array,
		})
		expect(target.data.config).toEqual({
			nested: true,
			first: true,
			second: true,
			component: true,
			winner: 'component',
		})
		expect(target.methods.behaviorOnly()).toBe('second')
		expect(target.methods.componentWins()).toBe('component')
		expect(target.relations['./behavior-only'].source).toBe('second')
		expect(target.relations['./component-wins'].source).toBe('component')
		expect(target.export()).toBe('component')
	})

	it('重复出现的 behavior 重新参与字段覆盖但不重复注册回调', () => {
		const nestedCreated = vi.fn()
		const referrerCreated = vi.fn()
		const nestedObserver = vi.fn()
		const nestedBehavior = {
			properties: { winner: String },
			data: { winner: 'nested' },
			methods: { winner: () => 'nested' },
			created: nestedCreated,
			observers: { winner: nestedObserver },
		}
		const referrerBehavior = {
			behaviors: [nestedBehavior],
			properties: { winner: Number },
			data: { winner: 'referrer' },
			methods: { winner: () => 'referrer' },
			created: referrerCreated,
		}
		const target = {}

		mergeBehaviors(target, [referrerBehavior, nestedBehavior])

		expect(target.properties.winner).toBe(String)
		expect(target.data.winner).toBe('nested')
		expect(target.methods.winner()).toBe('nested')
		expect(target.behaviorLifetimes.created).toEqual([nestedCreated, referrerCreated])
		expect(target.behaviorObserverList).toEqual([{ key: 'winner', observer: nestedObserver }])
	})

	it('深度合并时将低优先级 null 当作空对象', () => {
		const componentValue = { component: true }
		const target = {
			data: { config: componentValue },
		}

		mergeBehaviors(target, [{ data: { config: null } }])

		expect(target.data.config).toEqual(componentValue)
		expect(target.data.config).not.toBe(componentValue)
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

	it('uses behavior lifetimes entries instead of duplicate top-level lifecycle fields', () => {
		const topLevelCreated = vi.fn()
		const nestedCreated = vi.fn()
		const moved = vi.fn()
		const error = vi.fn()
		const target = {}

		mergeBehaviors(target, [{
			created: topLevelCreated,
			lifetimes: {
				created: nestedCreated,
				moved,
				error,
			},
		}])

		expect(target.behaviorLifetimes.created).toEqual([nestedCreated])
		expect(target.behaviorLifetimes.moved).toEqual([moved])
		expect(target.behaviorLifetimes.error).toEqual([error])
		expect(topLevelCreated).not.toHaveBeenCalled()
	})
})

describe('观察者函数参数测试', () => {
	it('单字段数据观察器只接收当前值', () => {
		const observer = vi.fn()
		const observers = {
			'numberA': observer,
		}
		const data = { numberA: 10 }
		const ctx = {}

		filterInvokeObserver('numberA', observers, data, ctx)

		expect(observer).toHaveBeenCalledWith(10)
	})

	it('嵌套字段数据观察器只接收当前值', () => {
		const observer = vi.fn()
		const observers = {
			'user.name': observer,
		}
		const data = { user: { name: 'John' } }
		const ctx = {}

		filterInvokeObserver('user.name', observers, data, ctx)

		expect(observer).toHaveBeenCalledWith('John')
	})

	it('多字段观察器不应该接收 oldVal 参数', () => {
		const observer = vi.fn()
		const observers = {
			'numberA, numberB': observer,
		}
		const data = { numberA: 10, numberB: 20 }
		const ctx = {}

		filterInvokeObserver('numberA', observers, data, ctx)

		expect(observer).toHaveBeenCalledWith(10, 20)
		expect(observer).not.toHaveBeenCalledWith(10, 20, 5)
	})
})

describe('syncUpdateChildrenProps', () => {
	it('triggers child property observers during parent setData sync', () => {
		const child = {
			__id__: 'child-1',
			__parentId__: 'parent-1',
			__pendingSyncedProps__: {},
			__info__: {
				properties: {
					show: {},
					name: {},
				},
			},
			tO: vi.fn(),
		}
		const parent = {
			__id__: 'parent-1',
			data: {
				show: true,
				name: 'fade',
			},
			__childPropsBindings__: {
				'child-1': {
					show: {
						expression: 'show',
						dependencies: ['show'],
						isSimple: true,
					},
					name: {
						expression: 'name',
						dependencies: ['name'],
						isSimple: true,
					},
				},
			},
		}

		syncUpdateChildrenProps(parent, {
			'child-1': child,
		}, {
			show: true,
			name: 'fade',
		})

		expect(child.tO).toHaveBeenCalledWith({
			show: true,
			name: 'fade',
		})
	})

	it('marks synced props after the immediate service-side child update', () => {
		const child = {
			__id__: 'child-1',
			__parentId__: 'parent-1',
			__pendingSyncedProps__: {},
			__info__: {
				properties: {
					show: {},
				},
			},
			tO: vi.fn(function tO(data) {
				expect(this.__pendingSyncedProps__).toEqual({})
				this.data.show = data.show
			}),
			data: {
				show: false,
			},
		}
		const parent = {
			__id__: 'parent-1',
			data: {
				show: true,
			},
			__childPropsBindings__: {
				'child-1': {
					show: {
						expression: 'show',
						dependencies: ['show'],
						isSimple: true,
					},
				},
			},
		}

		const syncedChildren = syncUpdateChildrenProps(parent, {
			'child-1': child,
		}, {
			show: true,
		})

		expect(child.data.show).toBe(true)
		expect(child.__pendingSyncedProps__).toEqual({ show: true })
		expect(syncedChildren).toEqual([{ child, data: { show: true } }])
	})

	it('deep-copies reference properties between parent and child instances', () => {
		const child = {
			__id__: 'child-reference',
			__parentId__: 'parent-reference',
			__pendingSyncedProps__: {},
			__info__: { properties: { item: {} } },
			data: {},
			tO(data) {
				Object.assign(this.data, data)
			},
		}
		const parent = {
			__id__: 'parent-reference',
			data: { item: { value: 1 } },
			__childPropsBindings__: {
				'child-reference': {
					item: {
						expression: 'item',
						dependencies: ['item'],
						isSimple: true,
					},
				},
			},
		}

		syncUpdateChildrenProps(parent, {
			[parent.__id__]: parent,
			[child.__id__]: child,
		}, { item: parent.data.item })

		expect(child.data.item).toEqual({ value: 1 })
		expect(child.data.item).not.toBe(parent.data.item)
		parent.data.item.value = 2
		expect(child.data.item.value).toBe(1)
	})

	it('preserves function identity when syncing a parent binding to a child property', () => {
		const fn = vi.fn()
		const child = {
			__id__: 'child-function',
			__parentId__: 'parent-function',
			__pendingSyncedProps__: {},
			__info__: { properties: { callback: {} } },
			data: {},
			tO(data) {
				Object.assign(this.data, data)
				return data
			},
		}
		const parent = {
			__id__: 'parent-function',
			data: { callback: fn },
			__childPropsBindings__: {
				'child-function': {
					callback: {
						expression: 'callback',
						dependencies: ['callback'],
						isSimple: true,
					},
				},
			},
		}

		const syncedChildren = syncUpdateChildrenProps(parent, {
			[parent.__id__]: parent,
			[child.__id__]: child,
		}, { callback: fn })

		expect(child.data.callback).toBe(fn)
		expect(child.__pendingSyncedProps__.callback).toBe(fn)
		expect(syncedChildren[0].data.callback).toBe(fn)
	})
})
