import { vi } from 'vitest'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

function createTestComponent({ bridgeId, moduleId, pageId, parentId, eventAttr = {}, targetInfo = {} }) {
	const componentModule = new ComponentModule({
		methods: {},
	}, {
		component: true,
		path: 'components/test',
		usingComponents: {},
	})

	return new Component(componentModule, {
		bridgeId,
		moduleId,
		path: 'components/test',
		pageId,
		parentId,
		eventAttr,
		properties: {},
		targetInfo,
	})
}

describe('Component triggerEvent', () => {
	beforeEach(() => {
		runtime.instances = {}
	})

	test('supports kebab-case custom event names bound as camelCase', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		runtime.instances[bridgeId] = {
			[pageId]: {
				actionHandle: vi.fn(),
			},
		}

		const componentModule = new ComponentModule({
			methods: {},
		}, {
			component: true,
			path: 'components/search',
			usingComponents: {},
		})

		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/search',
			pageId,
			parentId: pageId,
			eventAttr: {
				actionClick: 'actionHandle',
			},
			properties: {},
			targetInfo: {},
		})

		await component.triggerEvent('action-click', { value: 'cancel' })

		expect(runtime.instances[bridgeId][pageId].actionHandle).toHaveBeenCalledWith(expect.objectContaining({
			type: 'action-click',
			detail: { value: 'cancel' },
		}))
	})

	test('queues events for custom components until componentReadied', async () => {
		const bridgeId = 'test-bridge'
		const moduleId = 'component-1'
		const onLoad = vi.fn()

		runtime.instances[bridgeId] = {
			[moduleId]: {
				__type__: ComponentModule.type,
				__isComponent__: true,
				__componentReadied__: false,
				is: '/component/image',
				onLoad,
			},
		}

		const pending = runtime.triggerEvent({
			bridgeId,
			moduleId,
			methodName: 'onLoad',
			event: { detail: { width: 100 } },
		})

		expect(onLoad).not.toHaveBeenCalled()

		runtime.instances[bridgeId][moduleId].__componentReadied__ = true
		await runtime.flushPendingEvents(runtime.instances[bridgeId][moduleId])
		await pending

		expect(onLoad).toHaveBeenCalledWith({ detail: { width: 100 } })
	})

	test('dispatches capture from root to target before bubbling from target to root', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const calls = []
		const record = name => vi.fn((event) => {
			calls.push({
				name,
				currentTarget: event.currentTarget.id,
				target: event.target.id,
			})
		})
		runtime.instances[bridgeId] = {
			[pageId]: {
				targetCapture: record('target-capture'),
				targetBubble: record('target-bubble'),
				parentCapture: record('parent-capture'),
				parentBubble: record('parent-bubble'),
				rootCapture: record('root-capture'),
				rootBubble: record('root-bubble'),
			},
		}

		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId,
			parentId: pageId,
			eventAttr: {
				change: { captureBind: 'targetCapture', bind: 'targetBubble' },
			},
			targetInfo: { id: 'target', dataset: { role: 'target' } },
		})
		component.__eventPath__ = [
			{
				moduleId: pageId,
				eventAttr: { change: { captureBind: 'parentCapture', bind: 'parentBubble' } },
				targetInfo: { id: 'parent' },
			},
			{
				moduleId: pageId,
				eventAttr: { change: { captureBind: 'rootCapture', bind: 'rootBubble' } },
				targetInfo: { id: 'root' },
			},
		]

		await component.triggerEvent('change', { value: 1 }, {
			bubbles: true,
			capturePhase: true,
		})

		expect(calls).toEqual([
			{ name: 'root-capture', currentTarget: 'root', target: 'target' },
			{ name: 'parent-capture', currentTarget: 'parent', target: 'target' },
			{ name: 'target-capture', currentTarget: 'target', target: 'target' },
			{ name: 'target-bubble', currentTarget: 'target', target: 'target' },
			{ name: 'parent-bubble', currentTarget: 'parent', target: 'target' },
			{ name: 'root-bubble', currentTarget: 'root', target: 'target' },
		])
	})

	test('runs ancestor capture listeners without enabling bubbling', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const calls = []
		runtime.instances[bridgeId] = {
			[pageId]: {
				targetCapture: () => calls.push('target-capture'),
				targetBubble: () => calls.push('target-bubble'),
				rootCapture: () => calls.push('root-capture'),
				rootBubble: () => calls.push('root-bubble'),
			},
		}
		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId,
			parentId: pageId,
			eventAttr: { change: { captureBind: 'targetCapture', bind: 'targetBubble' } },
			targetInfo: { id: 'target' },
		})
		component.__eventPath__ = [{
			moduleId: pageId,
			eventAttr: { change: { captureBind: 'rootCapture', bind: 'rootBubble' } },
			targetInfo: { id: 'root' },
		}]

		await component.triggerEvent('change', {}, { capturePhase: true })

		expect(calls).toEqual(['root-capture', 'target-capture', 'target-bubble'])
	})

	test('only enters another component internal tree when composed is true', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const innerComponentId = 'component-parent'
		const calls = []
		runtime.instances[bridgeId] = {
			[pageId]: {
				targetHandler: () => calls.push('target'),
				outerHostHandler: () => calls.push('outer-host'),
			},
			[innerComponentId]: {
				innerHandler: () => calls.push('inner'),
			},
		}
		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId,
			parentId: innerComponentId,
			eventAttr: { custom: { bind: 'targetHandler' } },
			targetInfo: { id: 'target' },
		})
		component.__eventPath__ = [
			{
				moduleId: innerComponentId,
				eventAttr: { custom: { bind: 'innerHandler' } },
				targetInfo: { id: 'inner-view' },
			},
			{
				moduleId: pageId,
				eventAttr: { custom: { bind: 'outerHostHandler' } },
				targetInfo: { id: 'outer-host' },
			},
		]

		await component.triggerEvent('custom', {}, { bubbles: true })
		expect(calls).toEqual(['target', 'outer-host'])

		calls.length = 0
		await component.triggerEvent('custom', {}, { bubbles: true, composed: true })
		expect(calls).toEqual(['target', 'inner', 'outer-host'])
	})

	test('supplements a fragment-root component host from the service component tree', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const parentId = 'component-parent'
		const calls = []
		runtime.instances[bridgeId] = {
			[pageId]: {
				parentHost: event => calls.push(`host:${event.currentTarget.id}`),
			},
			[parentId]: {
				__isComponent__: true,
				__id__: parentId,
				__parentId__: pageId,
				__pageId__: pageId,
				__eventAttr__: { custom: { bind: 'parentHost' } },
				id: 'parent-host',
				dataset: { host: true },
				childInternal: () => calls.push('internal'),
			},
		}
		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId: parentId,
			parentId,
			eventAttr: { custom: { bind: 'targetHandler' } },
			targetInfo: { id: 'target' },
		})
		component.__eventPath__ = [{
			moduleId: parentId,
			eventAttr: { custom: { bind: 'childInternal' } },
			targetInfo: { id: 'inner-view' },
		}]
		runtime.instances[bridgeId][parentId].targetHandler = () => calls.push('target')

		await component.triggerEvent('custom', {}, { bubbles: true, composed: true })

		expect(calls).toEqual(['target', 'internal', 'host:parent-host'])
	})

	test('catch listeners terminate the remaining path', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const calls = []
		let caughtEvent
		runtime.instances[bridgeId] = {
			[pageId]: {
				targetHandler: () => calls.push('target'),
				catchHandler: (event) => {
					calls.push('catch')
					caughtEvent = event
				},
				rootHandler: () => calls.push('root'),
			},
		}
		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId,
			parentId: pageId,
			eventAttr: { custom: { bind: 'targetHandler' } },
			targetInfo: { id: 'target' },
		})
		component.__eventPath__ = [
			{
				moduleId: pageId,
				eventAttr: { custom: { catch: 'catchHandler' } },
				targetInfo: { id: 'catch-node' },
			},
			{
				moduleId: pageId,
				eventAttr: { custom: { bind: 'rootHandler' } },
				targetInfo: { id: 'root' },
			},
		]

		await component.triggerEvent('custom', {}, { bubbles: true })

		expect(calls).toEqual(['target', 'catch'])
		expect(caughtEvent.defaultPrevented).toBe(false)
	})

	test('stopPropagation called by a handler terminates the remaining path', async () => {
		const bridgeId = 'test-bridge'
		const pageId = 'page-1'
		const calls = []
		runtime.instances[bridgeId] = {
			[pageId]: {
				targetHandler: (event) => {
					calls.push('target')
					event.stopPropagation()
				},
				rootHandler: () => calls.push('root'),
			},
		}
		const component = createTestComponent({
			bridgeId,
			moduleId: 'component-1',
			pageId,
			parentId: pageId,
			eventAttr: { custom: { bind: 'targetHandler' } },
			targetInfo: { id: 'target' },
		})
		component.__eventPath__ = [{
			moduleId: pageId,
			eventAttr: { custom: { bind: 'rootHandler' } },
			targetInfo: { id: 'root' },
		}]

		await component.triggerEvent('custom', {}, { bubbles: true })

		expect(calls).toEqual(['target'])
	})
})
