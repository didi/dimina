import { vi } from 'vitest'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

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
})
