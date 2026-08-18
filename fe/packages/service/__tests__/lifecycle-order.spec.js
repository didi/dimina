import { getDataFunctionReferenceId, isDataFunctionReference } from '@dimina/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDataFunctionReferences, resolveDataFunction } from '../src/core/data-function'
import loader from '../src/core/loader'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'

describe('Skyline/exparser lifecycle ordering', () => {
	beforeEach(() => {
		resetDataFunctionReferences()
		runtime.instances = {}
		runtime.pageStates.clear()
		globalThis.DiminaServiceBridge.publish = vi.fn(() => Promise.resolve())
	})

	it('runs onLoad, onShow, component ready and page onReady once in render acknowledgement order', async () => {
		const calls = []
		const bridgeId = 'bridge-page-lifecycle'
		const pageModule = new PageModule({
			onLoad() {
				calls.push('page:onLoad')
			},
			onShow() {
				calls.push('page:onShow')
			},
			onReady() {
				calls.push('page:onReady')
			},
		}, {
			path: 'pages/lifecycle/index',
			usingComponents: {},
		})
		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/lifecycle/index',
			query: {},
		})
		await page.init()

		const component = {
			__id__: 'component-1',
			__type__: ComponentModule.type,
			__isComponent__: true,
			__componentAttached__: true,
			__componentReadied__: true,
			initd: true,
			pageShow: () => calls.push('component:show'),
		}
		runtime.instances[bridgeId] = {
			[page.__id__]: page,
			[component.__id__]: component,
		}

		runtime.pageReady({ bridgeId, moduleId: page.__id__ })
		runtime.pageShow({ bridgeId })
		runtime.pageReady({ bridgeId, moduleId: page.__id__ })

		expect(calls).toEqual([
			'page:onLoad',
			'component:show',
			'page:onShow',
			'page:onReady',
		])
	})

	it('queues an early pageShow until the page instance has finished onLoad', async () => {
		const calls = []
		const bridgeId = 'bridge-early-show'

		runtime.pageShow({ bridgeId })
		const page = {
			__id__: 'page-1',
			__type__: PageModule.type,
			initd: false,
			pageShow: () => calls.push('page:onShow'),
		}
		runtime.instances[bridgeId] = { [page.__id__]: page }
		runtime.pageShow({ bridgeId })
		expect(calls).toEqual([])

		page.initd = true
		runtime.pageShow({ bridgeId })
		expect(calls).toEqual(['page:onShow'])
	})

	it('does not synthesize pageShow while creating a page without a visibility signal', () => {
		const calls = []
		const bridgeId = 'bridge-no-synthetic-show'
		const path = 'pages/no-synthetic-show/index'
		loader.staticModules[path] = new PageModule({
			onLoad: () => calls.push('page:onLoad'),
			onShow: () => calls.push('page:onShow'),
		}, {
			path,
			usingComponents: {},
		})

		try {
			const page = runtime.createInstance({ bridgeId, moduleId: 'page-1', path, query: {} })
			expect(calls).toEqual(['page:onLoad'])

			runtime.pageShow({ bridgeId })
			expect(calls).toEqual(['page:onLoad', 'page:onShow'])
			runtime.pageUnload({ bridgeId, moduleId: page.__id__ })
		}
		finally {
			delete loader.staticModules[path]
		}
	})

	it('consumes a real pageShow signal queued before page creation', () => {
		const calls = []
		const bridgeId = 'bridge-pending-real-show'
		const path = 'pages/pending-real-show/index'
		loader.staticModules[path] = new PageModule({
			onLoad: () => calls.push('page:onLoad'),
			onShow: () => calls.push('page:onShow'),
		}, {
			path,
			usingComponents: {},
		})

		try {
			runtime.pageShow({ bridgeId })
			const page = runtime.createInstance({ bridgeId, moduleId: 'page-1', path, query: {} })

			expect(calls).toEqual(['page:onLoad', 'page:onShow'])
			runtime.pageUnload({ bridgeId, moduleId: page.__id__ })
		}
		finally {
			delete loader.staticModules[path]
		}
	})

	it('does not reshow a hidden page when render acknowledges pageReady', () => {
		const calls = []
		const bridgeId = 'bridge-hidden-ready'
		const page = {
			__id__: 'page-1',
			__type__: PageModule.type,
			initd: true,
			pageShow: () => calls.push('page:onShow'),
			pageHide: () => calls.push('page:onHide'),
			pageReady: () => calls.push('page:onReady'),
		}
		runtime.instances[bridgeId] = { [page.__id__]: page }

		runtime.pageShow({ bridgeId })
		runtime.pageHide({ bridgeId })
		runtime.pageReady({ bridgeId, moduleId: page.__id__ })

		expect(calls).toEqual(['page:onShow', 'page:onHide'])
		expect(runtime.getPageState(bridgeId)).toMatchObject({
			hidden: true,
			pendingReady: true,
			ready: false,
			shown: false,
		})

		runtime.pageShow({ bridgeId })
		expect(calls).toEqual([
			'page:onShow',
			'page:onHide',
			'page:onShow',
			'page:onReady',
		])
	})

	it('completes page lifecycle side effects in the init call stack', () => {
		let releaseOnLoad
		const pageModule = new PageModule({
			onLoad() {
				return new Promise((resolve) => {
					releaseOnLoad = resolve
				})
			},
		}, {
			path: 'pages/async-lifecycle/index',
			usingComponents: {},
		})
		const page = new Page(pageModule, {
			bridgeId: 'bridge-async-page',
			moduleId: 'page-1',
			path: 'pages/async-lifecycle/index',
			query: {},
		})

		const initResult = page.init()

		expect(initResult).toBeUndefined()
		expect(page.initd).toBe(true)
		expect(releaseOnLoad).toBeTypeOf('function')
		releaseOnLoad()
	})

	it('can defer only initial-data delivery without deferring page lifecycles', () => {
		const calls = []
		const dataFunction = vi.fn()
		const pageModule = new PageModule({
			data: {
				dataFunction,
				nested: { dataFunction },
				list: [dataFunction],
			},
			onLoad() {
				calls.push('page:onLoad')
			},
		}, {
			path: 'pages/deferred-data/index',
			usingComponents: {},
		})
		const page = new Page(pageModule, {
			bridgeId: 'bridge-deferred-data',
			moduleId: 'page-1',
			path: 'pages/deferred-data/index',
			query: {},
		})

		expect(page.init({ deferInitialData: true })).toBeUndefined()
		expect(calls).toEqual(['page:onLoad'])
		expect(globalThis.DiminaServiceBridge.publish).not.toHaveBeenCalled()

		page.sendInitialData()
		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(1)
		const [, initialDataMessage] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		const bridgedFunction = initialDataMessage.body.data.dataFunction
		expect(page.data.dataFunction).toBe(dataFunction)
		expect(page.data.nested.dataFunction).toBe(dataFunction)
		expect(page.data.list[0]).toBe(dataFunction)
		expect(isDataFunctionReference(bridgedFunction)).toBe(true)
		expect(initialDataMessage.body.data.nested.dataFunction).toEqual(bridgedFunction)
		expect(initialDataMessage.body.data.list[0]).toEqual(bridgedFunction)
		expect(resolveDataFunction(getDataFunctionReferenceId(bridgedFunction))).toBe(dataFunction)
	})

	it('runs custom component created, initial property observer, attached and ready in order', async () => {
		const calls = []
		const bridgeId = 'bridge-component-lifecycle'
		const module = new ComponentModule({
			properties: {
				value: {
					observer() {
						calls.push('property:observer')
					},
				},
			},
			lifetimes: {
				created() {
					calls.push('component:created')
				},
				attached() {
					calls.push('component:attached')
				},
				ready() {
					calls.push('component:ready')
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/lifecycle/index',
			usingComponents: {},
		})
		const component = new Component(module, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/lifecycle/index',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: { value: 'assigned' },
			propertyNames: ['value'],
			eventAttr: {},
			targetInfo: {},
		})
		runtime.instances[bridgeId] = { [component.__id__]: component }

		expect(component.init()).toBeUndefined()
		runtime.moduleReady({ bridgeId, moduleId: component.__id__ })
		expect(calls).toEqual(['component:created', 'property:observer'])

		expect(runtime.moduleAttached({ bridgeId, moduleId: component.__id__ })).toBeUndefined()
		expect(calls).toEqual([
			'component:created',
			'property:observer',
			'component:attached',
			'component:ready',
		])
	})

	it('completes component lifecycle side effects without adopting returned promises', () => {
		const pendingLifecycles = []
		const module = new ComponentModule({
			lifetimes: {
				created() {
					return new Promise(resolve => pendingLifecycles.push(resolve))
				},
				attached() {
					return new Promise(resolve => pendingLifecycles.push(resolve))
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/async-lifecycle/index',
			usingComponents: {},
		})
		const component = new Component(module, {
			bridgeId: 'bridge-async-component',
			moduleId: 'component-1',
			path: 'components/async-lifecycle/index',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {},
			propertyNames: [],
			eventAttr: {},
			targetInfo: {},
		})

		expect(component.init()).toBeUndefined()
		expect(component.componentAttached()).toBeUndefined()

		expect(component.initd).toBe(true)
		expect(pendingLifecycles).toHaveLength(2)
		pendingLifecycles.forEach(resolve => resolve())
	})

	it('queues child attached until its parent attaches and keeps the whole chain synchronous', () => {
		const calls = []
		const bridgeId = 'bridge-parent-child'
		const makeComponent = (id, parentId) => ({
			__id__: id,
			__parentId__: parentId,
			__type__: ComponentModule.type,
			__isComponent__: true,
			componentAttached: () => calls.push(`${id}:attached`),
			componentReadied: () => calls.push(`${id}:ready`),
		})
		const parent = makeComponent('parent', 'page-1')
		const child = makeComponent('child', 'parent')
		runtime.instances[bridgeId] = { parent, child }

		expect(runtime.moduleAttached({ bridgeId, moduleId: child.__id__ })).toBeUndefined()
		runtime.moduleReady({ bridgeId, moduleId: child.__id__ })
		runtime.moduleReady({ bridgeId, moduleId: parent.__id__ })
		expect(calls).toEqual([])

		expect(runtime.moduleAttached({ bridgeId, moduleId: parent.__id__ })).toBeUndefined()
		expect(calls).toEqual([
			'parent:attached',
			'child:attached',
			'child:ready',
			'parent:ready',
		])
	})

	it('marks a component ready before invoking a re-entrant ready callback', () => {
		const bridgeId = 'bridge-ready-reentrant'
		const component = {
			__id__: 'component-ready-reentrant',
			__type__: ComponentModule.type,
			__isComponent__: true,
			__componentAttached__: true,
			componentReadied: vi.fn(() => {
				runtime.moduleReady({ bridgeId, moduleId: component.__id__ })
			}),
			flushInitSetDataCallbacks: vi.fn(),
		}
		runtime.instances[bridgeId] = { [component.__id__]: component }

		runtime.moduleReady({ bridgeId, moduleId: component.__id__ })

		expect(component.componentReadied).toHaveBeenCalledTimes(1)
		expect(component.__componentReadied__).toBe(true)
	})

	it('dispatches page lifetimes in component-tree DFS order and detaches in post-order', () => {
		const calls = []
		const bridgeId = 'bridge-tree-order'
		const page = {
			__id__: 'page',
			__type__: PageModule.type,
			initd: true,
			pageShow: () => calls.push('page:show'),
			pageHide: () => calls.push('page:hide'),
			pageResize: () => calls.push('page:resize'),
			pageUnload: () => calls.push('page:unload'),
		}
		const component = (id, parentId) => ({
			__id__: id,
			__parentId__: parentId,
			__type__: ComponentModule.type,
			__isComponent__: true,
			__componentAttached__: true,
			pageShow: () => calls.push(`${id}:show`),
			pageHide: () => calls.push(`${id}:hide`),
			pageResize: () => calls.push(`${id}:resize`),
			componentRouteDone: () => calls.push(`${id}:routeDone`),
			componentDetached: () => calls.push(`${id}:detached`),
			pageUnload: vi.fn(),
		})
		const a = component('a', 'page')
		const b = component('b', 'page')
		const aChild = component('a-child', 'a')

		// a-child is intentionally inserted after its parent's sibling. A depth
		// sort would produce page,a,b,a-child instead of the source tree order.
		runtime.instances[bridgeId] = { page, a, b, 'a-child': aChild }

		runtime.pageShow({ bridgeId })
		runtime.pageHide({ bridgeId })
		runtime.pageResize({ bridgeId, size: { width: 320 } })
		runtime.componentRouteDone({ bridgeId })
		runtime.pageUnload({ bridgeId })

		expect(calls).toEqual([
			'a:show', 'a-child:show', 'b:show', 'page:show',
			'a:hide', 'a-child:hide', 'b:hide', 'page:hide',
			'a:resize', 'a-child:resize', 'b:resize', 'page:resize',
			'a:routeDone', 'a-child:routeDone', 'b:routeDone',
			'a-child:detached', 'a:detached', 'b:detached', 'page:unload',
		])
	})

	it('isolates lifecycle exceptions, reports error lifetimes and continues attachment', () => {
		const calls = []
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const module = new ComponentModule({
			behaviors: [{
				lifetimes: {
					created() {
						calls.push('behavior-1:created')
						throw new Error('created failed')
					},
					attached() {
						calls.push('behavior-1:attached')
						throw new Error('attached failed')
					},
					error(error) {
						calls.push(`behavior-1:error:${error.message}`)
					},
				},
			}, {
				created() {
					calls.push('behavior-2:created')
				},
				attached() {
					calls.push('behavior-2:attached')
				},
			}],
			lifetimes: {
				created() {
					calls.push('component:created')
				},
				attached() {
					calls.push('component:attached')
				},
				error(error) {
					calls.push(`component:error:${error.message}`)
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/errors/index',
			usingComponents: {},
		})
		const component = new Component(module, {
			bridgeId: 'bridge-errors',
			moduleId: 'component-errors',
			path: 'components/errors/index',
			pageId: 'page-1',
			parentId: 'page-1',
			properties: {},
			propertyNames: [],
			eventAttr: {},
			targetInfo: {},
		})
		runtime.instances['bridge-errors'] = { 'component-errors': component }

		expect(() => component.init()).not.toThrow()
		expect(() => runtime.moduleAttached({
			bridgeId: 'bridge-errors',
			moduleId: 'component-errors',
		})).not.toThrow()

		expect(component.__componentAttached__).toBe(true)
		expect(calls).toEqual([
			'behavior-1:created',
			'behavior-1:error:created failed',
			'component:error:created failed',
			'behavior-2:created',
			'component:created',
			'behavior-1:attached',
			'behavior-1:error:attached failed',
			'component:error:attached failed',
			'behavior-2:attached',
			'component:attached',
		])
		consoleError.mockRestore()
	})
})
