import { describe, expect, it } from 'vitest'
import { serializeProps } from '../src/core/utils'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'

function createComponent(properties, incomingProperties = {}) {
	const componentModule = new ComponentModule({
		properties,
	}, {
		component: true,
	})
	return new Component(componentModule, {
		bridgeId: 'bridge-properties',
		moduleId: `component-${Math.random()}`,
		path: '/property-component',
		pageId: 'page-properties',
		parentId: 'page-properties',
		properties: incomingProperties,
	})
}

describe('component property normalization', () => {
	it('serializes the primary type before optionalTypes', () => {
		expect(serializeProps({
			mixed: { type: String, optionalTypes: [Boolean, Object] },
		})).toEqual({
			mixed: {
				type: ['s', 'b', 'o'],
				default: '',
			},
		})
		expect(serializeProps({ callback: Function })).toEqual({
			callback: {
				type: [null],
				default: null,
			},
		})
	})

	it('uses declared defaults only when a property is absent', async () => {
		const component = createComponent({
			label: { type: String, value: 'default-label' },
			items: Array,
		})

		await component.init()

		expect(component.data.label).toBe('default-label')
		expect(component.data.items).toEqual([])
	})

	it('converts initial and updated values with mini-program semantics', async () => {
		const component = createComponent({
			label: String,
			active: Boolean,
			count: Number,
			items: Array,
			mixed: { type: String, optionalTypes: [Boolean] },
		}, {
			label: null,
			active: '',
			count: '12.5',
			items: {},
			mixed: true,
		})

		await component.init()
		expect(component.data).toMatchObject({
			label: '',
			active: false,
			count: 12.5,
			items: [],
			mixed: true,
		})

		component.tO({
			label: false,
			active: 'false',
			count: 'invalid',
		})
		expect(component.data).toMatchObject({
			label: 'false',
			active: true,
			count: 0,
		})
	})

	it('does not share implicit array defaults between component instances', async () => {
		const first = createComponent({ items: Array })
		const second = createComponent({ items: Array })
		await first.init()
		await second.init()

		first.data.items.push('first')
		expect(second.data.items).toEqual([])
	})

	it('runs property filters after type conversion and before property observers', () => {
		const calls = []
		const componentModule = new ComponentModule({
			properties: {
				count: {
					type: Number,
					filter: 'clampCount',
					observer(value, oldValue, path) {
						calls.push(['observer', value, oldValue, path])
					},
				},
			},
			methods: {
				clampCount(value, oldValue, path) {
					calls.push(['filter', value, oldValue, path])
					return Math.min(value, 10)
				},
			},
			lifetimes: {
				created() {
					calls.push(['created', this.data.count])
				},
			},
		}, { component: true })
		const component = new Component(componentModule, {
			bridgeId: 'bridge-filter',
			moduleId: 'component-filter',
			path: '/property-filter',
			pageId: 'page-filter',
			parentId: 'page-filter',
			properties: { count: '12' },
		})

		component.init()
		expect(component.data.count).toBe(10)
		expect(calls).toEqual([
			['created', 0],
			['filter', 12, 0, ['count']],
			['observer', 10, 0, ['count']],
		])

		component.tO({ count: '7' })
		expect(component.data.count).toBe(7)
		expect(calls.slice(3)).toEqual([
			['filter', 7, 10, ['count']],
			['observer', 7, 10, ['count']],
		])

		component.tO({ count: '12' })
		component.__pendingSyncedProps__.count = 12
		const callCountBeforeReplay = calls.length
		expect(component.tO({ count: '12' })).toEqual({ count: 10 })
		expect(component.data.count).toBe(10)
		expect(calls).toHaveLength(callCountBeforeReplay)
	})

	it('keeps created-time property updates and uses them as the old incoming value', () => {
		const calls = []
		const componentModule = new ComponentModule({
			properties: {
				count: {
					type: Number,
					observer(value, oldValue) {
						calls.push([value, oldValue])
					},
				},
			},
			lifetimes: {
				created() {
					this.setData({ count: 3 })
				},
			},
			methods: {},
		}, { component: true })
		const component = new Component(componentModule, {
			bridgeId: 'bridge-created-property',
			moduleId: 'component-created-property',
			path: '/created-property',
			pageId: 'page-created-property',
			parentId: 'page-created-property',
			properties: { count: 5 },
		})

		component.init()

		expect(component.data.count).toBe(5)
		expect(calls).toEqual([
			[3, 0],
			[5, 3],
		])

		const absentComponent = new Component(componentModule, {
			bridgeId: 'bridge-created-property-absent',
			moduleId: 'component-created-property-absent',
			path: '/created-property',
			pageId: 'page-created-property-absent',
			parentId: 'page-created-property-absent',
			properties: {},
		})
		absentComponent.init()
		expect(absentComponent.data.count).toBe(3)
		expect(calls.at(-1)).toEqual([3, 0])
	})
})
