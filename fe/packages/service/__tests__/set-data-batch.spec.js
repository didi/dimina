import { callback as callbackRegistry } from '@dimina/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUpdateQueues } from '../src/core/update-queue'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import { Page } from '../src/instance/page/page'

describe('setData update batching', () => {
	const sentMessages = []

	beforeEach(() => {
		sentMessages.length = 0
		resetUpdateQueues()
		runtime.instances = {}
		globalThis.DiminaServiceBridge.publish = vi.fn((_bridgeId, msg) => {
			sentMessages.push(msg)
			return Promise.resolve()
		})
	})

	it('batches multiple page setData calls in the same tick', async () => {
		const page = {
			data: {},
			initd: true,
			bridgeId: 'bridge-1',
			__id__: 'page-1',
			__childPropsBindings__: {},
		}
		runtime.instances[page.bridgeId] = {
			[page.__id__]: page,
		}

		Page.prototype.setData.call(page, { count: 1 })
		Page.prototype.setData.call(page, { name: 'dimina' })

		expect(sentMessages).toEqual([])

		await Promise.resolve()

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0]).toMatchObject({
			type: 'ub',
			target: 'render',
			body: {
				bridgeId: page.bridgeId,
				callbackIds: [],
				updates: [
					{
						moduleId: page.__id__,
						data: {
							count: 1,
							name: 'dimina',
						},
					},
				],
			},
		})
	})

	it('flushes groupSetData once after the group ends and includes synced children', () => {
		const child = {
			__id__: 'child-1',
			__parentId__: 'component-1',
			__pendingSyncedProps__: {},
			__info__: {
				properties: {
					count: {},
				},
			},
			data: {
				count: 0,
			},
			tO: vi.fn(function tO(data) {
				Object.assign(this.data, data)
			}),
		}
		const component = {
			data: {},
			initd: true,
			bridgeId: 'bridge-1',
			__id__: 'component-1',
			__info__: {},
			__childPropsBindings__: {
				'child-1': {
					count: {
						expression: 'count',
						dependencies: ['count'],
						isSimple: true,
					},
				},
			},
			__groupSetDataMode__: false,
			__groupSetDataBuffer__: {},
		}
		runtime.instances[component.bridgeId] = {
			[component.__id__]: component,
			[child.__id__]: child,
		}

		Component.prototype.groupSetData.call(component, function groupUpdate() {
			Component.prototype.setData.call(this, { count: 1 })
			Component.prototype.setData.call(this, { name: 'dimina' })
			expect(sentMessages).toEqual([])
		})

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0]).toMatchObject({
			type: 'ub',
			target: 'render',
			body: {
				bridgeId: component.bridgeId,
				updates: [
					{
						moduleId: component.__id__,
						data: {
							count: 1,
							name: 'dimina',
						},
					},
					{
						moduleId: child.__id__,
						data: {
							count: 1,
						},
					},
				],
			},
		})
		expect(child.tO).toHaveBeenCalledWith({ count: 1 })
		expect(child.__pendingSyncedProps__).toEqual({ count: 1 })
	})

	it('defers setData callback until the render layer acknowledges the batch', async () => {
		const page = {
			data: {},
			initd: true,
			bridgeId: 'bridge-1',
			__id__: 'page-1',
			__childPropsBindings__: {},
		}
		const callback = vi.fn(function onSetData() {
			expect(this).toBe(page)
		})
		runtime.instances[page.bridgeId] = {
			[page.__id__]: page,
		}

		Page.prototype.setData.call(page, { count: 1 }, callback)
		expect(callback).not.toHaveBeenCalled()

		await Promise.resolve()

		expect(callback).not.toHaveBeenCalled()
		expect(sentMessages[0].body.callbackIds).toEqual([expect.any(String)])

		callbackRegistry.invoke(sentMessages[0].body.callbackIds[0])

		expect(callback).toHaveBeenCalledTimes(1)
	})

	it('keeps setData callbacks registered during component initialization until render ack', async () => {
		const bridgeId = 'bridge-1'
		const callback = vi.fn()
		const componentModule = new ComponentModule({
			data: {},
			properties: {},
			lifetimes: {
				attached() {
					this.setData({ currentIndex: 0 }, callback)
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/tabs',
			usingComponents: {},
		})
		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {},
		})
		runtime.instances[bridgeId] = {
			[component.__id__]: component,
		}

		component.init()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(callback).not.toHaveBeenCalled()
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0]).toMatchObject({
			type: component.__id__,
			target: 'render',
			body: {
				bridgeId,
				data: {
					currentIndex: 0,
				},
			},
		})

		runtime.moduleReady({
			bridgeId,
			moduleId: component.__id__,
		})
		await Promise.resolve()

		expect(callback).not.toHaveBeenCalled()
		expect(sentMessages).toHaveLength(2)
		expect(sentMessages[1]).toMatchObject({
			type: 'ub',
			target: 'render',
			body: {
				bridgeId,
				callbackIds: [expect.any(String)],
				updates: [
					{
						moduleId: component.__id__,
						data: {},
					},
				],
			},
		})

		callbackRegistry.invoke(sentMessages[1].body.callbackIds[0])

		expect(callback).toHaveBeenCalledTimes(1)
	})

	it('applies defaultValue after descendant relations are linked during initialization', async () => {
		const bridgeId = 'bridge-1'
		const parentModule = new ComponentModule({
			data: {
				currentIndex: -1,
				tabs: [],
			},
			properties: {
				value: {
					type: null,
					value: null,
				},
				defaultValue: {
					type: null,
				},
			},
			relations: {
				'components/tab-panel': {
					type: 'descendant',
					linked(target) {
						this.children.push(target)
						this.updateTabs()
					},
				},
			},
			observers: {
				value(name) {
					if (name !== this.getCurrentName()) {
						this.setCurrentIndexByName(name)
					}
				},
			},
			lifetimes: {
				created() {
					this.children = []
				},
				attached() {
					if (this.properties.value == null && this.properties.defaultValue != null) {
						this.setData({ value: this.properties.defaultValue })
					}
				},
			},
			methods: {
				updateTabs() {
					this.setData({ tabs: this.children.map(child => child.data) })
					this.setCurrentIndexByName(this.properties.value)
				},
				setCurrentIndexByName(name) {
					const index = this.children.findIndex(child => child.getComputedName() === `${name}`)
					if (index > -1) {
						this.setData({ currentIndex: index })
					}
				},
				getCurrentName() {
					return this.children[this.data.currentIndex]?.getComputedName()
				},
			},
		}, {
			component: true,
			path: 'components/tabs',
			usingComponents: {},
		})
		const childModule = new ComponentModule({
			data: {},
			properties: {
				value: {
					type: null,
				},
			},
			relations: {
				'components/tabs': {
					type: 'ancestor',
				},
			},
			methods: {
				getComputedName() {
					if (this.properties.value != null) {
						return `${this.properties.value}`
					}
					return `${this.index}`
				},
			},
		}, {
			component: true,
			path: 'components/tab-panel',
			usingComponents: {},
		})
		const parent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'components/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {
				defaultValue: 'recommend',
			},
			targetInfo: {},
		})
		const child = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'components/tab-panel',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {
				value: 'recommend',
			},
			targetInfo: {},
		})
		runtime.instances[bridgeId] = {
			[parent.__id__]: parent,
			[child.__id__]: child,
		}

		parent.init()
		child.init()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(parent.data.value).toBe('recommend')
		expect(parent.data.currentIndex).toBe(0)
	})

	it('links mutually declared ancestor relations when slot rendering loses the direct parent chain', async () => {
		const bridgeId = 'bridge-1'
		const parentModule = new ComponentModule({
			data: {
				currentIndex: -1,
			},
			properties: {
				value: {
					type: null,
					value: null,
				},
				defaultValue: {
					type: null,
				},
			},
			relations: {
				'components/tab-panel': {
					type: 'descendant',
					linked(target) {
						this.children.push(target)
						this.setCurrentIndexByName(this.properties.value)
					},
				},
			},
			observers: {
				value(name) {
					this.setCurrentIndexByName(name)
				},
			},
			lifetimes: {
				created() {
					this.children = []
				},
				attached() {
					this.setData({ value: this.properties.defaultValue })
				},
			},
			methods: {
				setCurrentIndexByName(name) {
					const index = this.children.findIndex(child => child.getComputedName() === `${name}`)
					if (index > -1) {
						this.setData({ currentIndex: index })
					}
				},
			},
		}, {
			component: true,
			path: 'components/tabs',
			usingComponents: {},
		})
		const childModule = new ComponentModule({
			data: {},
			properties: {
				value: {
					type: null,
				},
			},
			relations: {
				'components/tabs': {
					type: 'ancestor',
				},
			},
			methods: {
				getComputedName() {
					return `${this.properties.value}`
				},
			},
		}, {
			component: true,
			path: 'components/tab-panel',
			usingComponents: {},
		})
		const parent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'components/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {
				defaultValue: 'recommend',
			},
			targetInfo: {},
		})
		const child = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'components/tab-panel',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {
				value: 'recommend',
			},
			targetInfo: {},
		})
		runtime.instances[bridgeId] = {
			[parent.__id__]: parent,
			[child.__id__]: child,
		}

		parent.init()
		child.init()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(parent.children).toEqual([child])
		expect(parent.data.currentIndex).toBe(0)
	})

	it('links implicit descendant relations when the child is initialized first', async () => {
		const bridgeId = 'bridge-1'
		const parentModule = new ComponentModule({
			data: {
				currentIndex: -1,
			},
			properties: {
				value: {
					type: null,
					value: null,
				},
				defaultValue: {
					type: null,
				},
			},
			relations: {
				'components/tab-panel': {
					type: 'descendant',
					linked(target) {
						this.children.push(target)
						this.setCurrentIndexByName(this.properties.value)
					},
				},
			},
			observers: {
				value(name) {
					this.setCurrentIndexByName(name)
				},
			},
			lifetimes: {
				created() {
					this.children = []
				},
				attached() {
					this.setData({ value: this.properties.defaultValue })
				},
			},
			methods: {
				setCurrentIndexByName(name) {
					const index = this.children.findIndex(child => child.getComputedName() === `${name}`)
					if (index > -1) {
						this.setData({ currentIndex: index })
					}
				},
			},
		}, {
			component: true,
			path: 'components/tabs',
			usingComponents: {},
		})
		const childModule = new ComponentModule({
			data: {},
			properties: {
				value: {
					type: null,
				},
			},
			relations: {
				'components/tabs': {
					type: 'ancestor',
				},
			},
			methods: {
				getComputedName() {
					return `${this.properties.value}`
				},
			},
		}, {
			component: true,
			path: 'components/tab-panel',
			usingComponents: {},
		})
		const child = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'components/tab-panel',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {
				value: 'recommend',
			},
			targetInfo: {},
		})
		const parent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'components/tabs',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {
				defaultValue: 'recommend',
			},
			targetInfo: {},
		})
		runtime.instances[bridgeId] = {
			[child.__id__]: child,
			[parent.__id__]: parent,
		}

		child.init()
		parent.init()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(parent.children).toEqual([child])
		expect(parent.data.currentIndex).toBe(0)
	})
})
