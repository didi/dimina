import { describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'

describe('Component.tO observer ordering', () => {
	it('isolates observer exceptions and continues in registration order', () => {
		const calls = []
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const instance = {
			data: { count: 0 },
			__pendingSyncedProps__: {},
			__info__: {
				behaviorObserverList: [{
					key: 'count',
					observer() {
						calls.push('behavior-1')
						throw new Error('observer failed')
					},
				}, {
					key: 'count',
					observer() {
						calls.push('behavior-2')
					},
				}],
				observers: {
					count() {
						calls.push('component')
					},
				},
				properties: {},
			},
		}

		Component.prototype.tO.call(instance, { count: 1 })

		expect(calls).toEqual(['behavior-1', 'behavior-2', 'component'])
		expect(instance.data.count).toBe(1)
		error.mockRestore()
	})

	it('executes property observers for initial component properties', async () => {
		const componentModule = new ComponentModule({
			properties: {
				icon: {
					observer: 'observeIcon',
				},
			},
			methods: {
				observeIcon(icon) {
					this.setData({ _icon: icon ? { name: icon } : null })
				},
			},
		}, {
			component: true,
		})

		const component = new Component(componentModule, {
			bridgeId: 'bridge-1',
			moduleId: 'button-1',
			path: '/button',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {
				icon: 'add',
			},
		})

		await component.init()
		component.componentReadied()

		expect(component.data._icon).toEqual({ name: 'add' })
	})

	it('runs initial property observers after behavior created hooks', async () => {
		const componentModule = new ComponentModule({
			behaviors: [{
				created() {
					Object.defineProperty(this, 'children', {
						get() {
							return []
						},
						configurable: true,
					})
				},
			}],
			properties: {
				animated: {
					type: Boolean,
					observer() {
						this.children.forEach(() => {})
						this.data._animatedObserved = true
					},
				},
			},
		}, {
			component: true,
		})

		const component = new Component(componentModule, {
			bridgeId: 'bridge-1',
			moduleId: 'tabs-1',
			path: '/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {
				animated: true,
			},
		})

		expect(component.init()).toBeUndefined()
		component.componentReadied()
		expect(component.data._animatedObserved).toBe(true)
	})

	it('applies incoming properties after created by default', () => {
		const calls = []
		const componentModule = new ComponentModule({
			properties: {
				active: {
					type: Boolean,
					observer(value) {
						calls.push(`observer:${value}`)
					},
				},
			},
			lifetimes: {
				created() {
					calls.push(`created:${this.data.active}`)
				},
			},
			methods: {},
		}, { component: true })
		const component = new Component(componentModule, {
			bridgeId: 'bridge-late-properties',
			moduleId: 'component-late-properties',
			path: '/late-properties',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: { active: true },
			propertyNames: ['active'],
		})

		component.init()

		expect(calls).toEqual(['created:false', 'observer:true'])
		expect(component.data.active).toBe(true)
	})

	it('does not let non-exparser options move property observers before created', () => {
		const calls = []
		const componentModule = new ComponentModule({
			options: { propertyEarlyInit: true },
			properties: {
				active: {
					type: Boolean,
					observer(value) {
						calls.push(`observer:${value}`)
					},
				},
			},
			lifetimes: {
				created() {
					calls.push(`created:${this.data.active}`)
				},
			},
			methods: {},
		}, { component: true })
		const component = new Component(componentModule, {
			bridgeId: 'bridge-early-properties',
			moduleId: 'component-early-properties',
			path: '/early-properties',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: { active: true },
			propertyNames: ['active'],
		})

		component.init()

		expect(calls).toEqual(['created:false', 'observer:true'])
	})

	it('executes initial property observers after created and only once', async () => {
		const observeSrc = vi.fn(function observeSrc(src) {
			this.data.loading = !!src
		})

		const componentModule = new ComponentModule({
			data: {
				loading: false,
			},
			properties: {
				src: {
					observer: 'observeSrc',
				},
			},
			methods: {
				observeSrc,
			},
		}, {
			component: true,
		})

		const component = new Component(componentModule, {
			bridgeId: 'bridge-1',
			moduleId: 'image-1',
			path: '/image',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {
				src: 'https://img.yzcdn.cn/vant/cat.jpeg',
			},
		})

		await component.init()
		expect(observeSrc).toHaveBeenCalledTimes(1)
		expect(component.data.loading).toBe(true)

		component.componentReadied()
		expect(observeSrc).toHaveBeenCalledTimes(1)
	})

	it('executes initial property observers before attached for relation components', async () => {
		const observeActive = vi.fn(function observeActive(val) {
			this.data._observedActive = val
		})

		const componentModule = new ComponentModule({
			relations: {
				'../tab/index': {
					type: 'descendant',
				},
			},
			properties: {
				active: {
					observer: 'observeActive',
				},
			},
			methods: {
				observeActive,
			},
		}, {
			component: true,
		})

		const component = new Component(componentModule, {
			bridgeId: 'bridge-1',
			moduleId: 'tabs-1',
			path: '/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {
				active: 0,
			},
		})

		await component.init()
		expect(observeActive).toHaveBeenCalledTimes(1)
		expect(component.data._observedActive).toBe(0)
	})

	it('executes property observers in assignment order after data observers', () => {
		const calls = []
		const instance = {
			data: {
				show: false,
				position: 'center',
				name: 'fade',
			},
			__pendingSyncedProps__: {},
			__info__: {
				observers: {
					'show': () => {
						calls.push('observers:show')
					},
				},
				properties: {
					show: {
						observer: 'observeShow',
					},
					position: {
						observer: 'observeClass',
					},
				},
			},
			observeClass: vi.fn(function observeClass() {
				this.data.name = this.data.position
				calls.push(`observeClass:${this.data.name}`)
			}),
			observeShow: vi.fn(function observeShow() {
				calls.push(`observeShow:${this.data.name}`)
			}),
		}

		Component.prototype.tO.call(instance, {
			show: true,
			position: 'top',
		})

		expect(calls).toEqual([
			'observers:show',
			'observeShow:fade',
			'observeClass:top',
		])
	})

	it('skips identical assignments and preserves changed-property order', () => {
		const calls = []
		const instance = {
			data: {
				defaultDate: 1,
				type: 'single',
				currentDate: null,
			},
			__pendingSyncedProps__: {},
			__info__: {
				observers: {},
				properties: {
					defaultDate: {
						observer: 'observeDefaultDate',
					},
					type: {
						observer: 'observeType',
					},
				},
			},
			observeDefaultDate: vi.fn(function observeDefaultDate(val) {
				this.data.currentDate = val
				calls.push(`defaultDate:${this.data.currentDate}`)
			}),
			observeType: vi.fn(function observeType() {
				if (this.data.type === 'multiple') {
					this.data.currentDate = [this.data.defaultDate]
				}
				calls.push(`type:${Array.isArray(this.data.currentDate) ? 'array' : typeof this.data.currentDate}`)
			}),
		}

		Component.prototype.tO.call(instance, {
			defaultDate: 1,
			type: 'multiple',
		})

		expect(calls).toEqual([
			'type:array',
		])
		expect(instance.data.currentDate).toEqual([1])
	})

	it('skips duplicate observer execution but keeps data in sync for identical render replay after parent sync', () => {
		const observeShow = vi.fn()
		const instance = {
			data: {
				show: false,
			},
			__pendingSyncedProps__: {
				show: true,
			},
			__info__: {
				observers: {},
				properties: {
					show: {
						observer: 'observeShow',
					},
				},
			},
			observeShow,
		}

		Component.prototype.tO.call(instance, {
			show: true,
		})

		expect(observeShow).not.toHaveBeenCalled()
		expect(instance.__pendingSyncedProps__).toEqual({})
		expect(instance.data.show).toBe(true)
	})

	it('does not throw when triggerEvent has no external listener', async () => {
		const instance = {
			bridgeId: 'bridge-1',
			__pageId__: 'page-1',
			__eventAttr__: {},
			id: 'tabs-1',
			dataset: {},
		}
		const trigger = vi.spyOn(runtime, 'triggerEvent')

		await expect(Component.prototype.triggerEvent.call(instance, 'change', { value: 'follow' })).resolves.toBeUndefined()
		expect(trigger).not.toHaveBeenCalled()

		trigger.mockRestore()
	})

	it('executes property observers for internal setData on properties', () => {
		const instance = {
			data: {
				visible: false,
			},
			initd: false,
			__pendingInitSetDataCallbacks__: [],
			__info__: {
				properties: {
					visible: {
						observer: 'watchVisible',
					},
				},
			},
			watchVisible: vi.fn(),
		}

		Component.prototype.setData.call(instance, {
			visible: true,
		})

		expect(instance.data.visible).toBe(true)
		expect(instance.watchVisible).toHaveBeenCalledWith(true, false, ['visible'])
	})
})
