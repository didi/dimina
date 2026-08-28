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

	it('waits for initial component attachment before onLoad, show and ready', () => {
		const calls = []
		const bridgeId = 'bridge-page-attached-handshake'
		const pageModule = new PageModule({
			onLoad: () => calls.push('page:onLoad'),
			onShow: () => calls.push('page:onShow'),
			onReady: () => calls.push('page:onReady'),
		}, {
			path: 'pages/attached-handshake/index',
			usingComponents: {},
		})
		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page',
			path: 'pages/attached-handshake/index',
			query: {},
		})
		page.init({ deferInitialData: true, deferPageLoad: true })

		const component = {
			__id__: 'component',
			__parentId__: page.__id__,
			__type__: ComponentModule.type,
			__isComponent__: true,
			initd: true,
			componentAttached: () => calls.push('component:attached'),
			componentReadied: () => calls.push('component:ready'),
			pageShow: () => calls.push('component:show'),
			flushInitSetDataCallbacks: vi.fn(),
		}
		runtime.instances[bridgeId] = { page, component }

		runtime.pageShow({ bridgeId })
		runtime.moduleAttached({ bridgeId, moduleId: component.__id__ })
		runtime.moduleReady({ bridgeId, moduleId: component.__id__ })
		expect(calls).toEqual(['component:attached'])

		runtime.pageAttached({ bridgeId, moduleId: page.__id__ })
		runtime.pageReady({ bridgeId, moduleId: page.__id__ })

		expect(calls).toEqual([
			'component:attached',
			'page:onLoad',
			'component:show',
			'page:onShow',
			'component:ready',
			'page:onReady',
		])
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

	it('does not synthesize show for a component attached to an already-visible page', () => {
		const calls = []
		const bridgeId = 'bridge-late-visible-component'
		const page = {
			__id__: 'page',
			__type__: PageModule.type,
			initd: true,
			pageShow: () => calls.push('page:show'),
			pageHide: () => calls.push('page:hide'),
		}
		runtime.instances[bridgeId] = { page }
		runtime.pageShow({ bridgeId })
		runtime.getPageState(bridgeId).ready = true

		const component = {
			__id__: 'late-component',
			__parentId__: page.__id__,
			__type__: ComponentModule.type,
			__isComponent__: true,
			componentAttached: () => calls.push('component:attached'),
			pageShow: () => calls.push('component:show'),
			pageHide: () => calls.push('component:hide'),
		}
		runtime.instances[bridgeId][component.__id__] = component
		runtime.moduleAttached({ bridgeId, moduleId: component.__id__ })

		expect(calls).toEqual(['page:show', 'component:attached'])

		runtime.pageHide({ bridgeId })
		runtime.pageShow({ bridgeId })
		expect(calls).toEqual([
			'page:show',
			'component:attached',
			'component:hide',
			'page:hide',
			'component:show',
			'page:show',
		])
	})

	it('preserves initial component show when attachment crosses the first visibility signal', () => {
		const calls = []
		const bridgeId = 'bridge-initial-visible-component'
		const page = {
			__id__: 'page',
			__type__: PageModule.type,
			initd: true,
			pageShow: () => calls.push('page:show'),
		}
		const component = {
			__id__: 'initial-component',
			__parentId__: page.__id__,
			__type__: ComponentModule.type,
			__isComponent__: true,
			componentAttached: () => calls.push('component:attached'),
			pageShow: () => calls.push('component:show'),
		}
		runtime.instances[bridgeId] = { page }

		runtime.pageShow({ bridgeId })
		runtime.instances[bridgeId][component.__id__] = component
		runtime.moduleAttached({ bridgeId, moduleId: component.__id__ })

		expect(calls).toEqual([
			'page:show',
			'component:attached',
			'component:show',
		])
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
			pageDetached: () => calls.push('page:detached'),
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
			'page:unload', 'a-child:detached', 'a:detached', 'b:detached', 'page:detached',
		])
	})

	it('keeps lifecycle state isolated for sibling instances created from the same component module', () => {
		const calls = []
		const bridgeId = 'bridge-same-component-siblings'
		const path = 'components/same-definition/index'
		const module = new ComponentModule({
			lifetimes: {
				created() {
					calls.push(`${this.__id__}:created`)
				},
				attached() {
					calls.push(`${this.__id__}:attached`)
				},
				ready() {
					calls.push(`${this.__id__}:ready`)
				},
				detached() {
					calls.push(`${this.__id__}:detached`)
				},
			},
			pageLifetimes: {
				show() {
					calls.push(`${this.__id__}:show`)
				},
				hide() {
					calls.push(`${this.__id__}:hide`)
				},
				resize() {
					calls.push(`${this.__id__}:resize`)
				},
				routeDone() {
					calls.push(`${this.__id__}:routeDone`)
				},
			},
			methods: {},
		}, {
			component: true,
			path,
			usingComponents: {},
		})
		const page = {
			__id__: 'page',
			__type__: PageModule.type,
			initd: true,
			pageShow: () => calls.push('page:show'),
			pageHide: () => calls.push('page:hide'),
			pageResize: () => calls.push('page:resize'),
			pageUnload: () => calls.push('page:unload'),
			pageDetached: () => calls.push('page:detached'),
		}
		const createSibling = moduleId => new Component(module, {
			bridgeId,
			moduleId,
			path,
			pageId: page.__id__,
			parentId: page.__id__,
			properties: {},
			propertyNames: [],
			eventAttr: {},
			targetInfo: {},
		})
		const siblingA = createSibling('sibling-a')
		const siblingB = createSibling('sibling-b')
		runtime.instances[bridgeId] = {
			[page.__id__]: page,
			[siblingA.__id__]: siblingA,
			[siblingB.__id__]: siblingB,
		}

		siblingA.init()
		siblingB.init()
		runtime.moduleAttached({ bridgeId, moduleId: siblingA.__id__ })
		runtime.moduleAttached({ bridgeId, moduleId: siblingB.__id__ })
		runtime.moduleReady({ bridgeId, moduleId: siblingA.__id__ })
		runtime.moduleReady({ bridgeId, moduleId: siblingB.__id__ })
		runtime.pageShow({ bridgeId })
		runtime.pageHide({ bridgeId })
		runtime.pageResize({ bridgeId, size: { width: 320, height: 640 } })
		runtime.componentRouteDone({ bridgeId })
		runtime.pageUnload({ bridgeId })

		const lifecycleOf = id => calls
			.filter(call => call.startsWith(`${id}:`))
			.map(call => call.slice(id.length + 1))

		// WeChat does not promise an observable order between sibling instances.
		// Assert each instance and the page boundary independently instead.
		expect(lifecycleOf('sibling-a')).toEqual([
			'created', 'attached', 'ready', 'show', 'hide', 'resize', 'routeDone', 'detached',
		])
		expect(lifecycleOf('sibling-b')).toEqual([
			'created', 'attached', 'ready', 'show', 'hide', 'resize', 'routeDone', 'detached',
		])
		expect(lifecycleOf('page')).toEqual(['show', 'hide', 'resize', 'unload', 'detached'])
		expect(calls).toHaveLength(21)

		for (const event of ['show', 'hide', 'resize']) {
			expect(calls.indexOf('page:' + event)).toBeGreaterThan(calls.indexOf('sibling-a:' + event))
			expect(calls.indexOf('page:' + event)).toBeGreaterThan(calls.indexOf('sibling-b:' + event))
		}
		expect(calls.indexOf('page:unload')).toBeLessThan(calls.indexOf('sibling-a:detached'))
		expect(calls.indexOf('page:unload')).toBeLessThan(calls.indexOf('sibling-b:detached'))
		expect(calls.indexOf('page:detached')).toBeGreaterThan(calls.indexOf('sibling-a:detached'))
		expect(calls.indexOf('page:detached')).toBeGreaterThan(calls.indexOf('sibling-b:detached'))
		expect(runtime.instances[bridgeId]).toBeUndefined()
	})

	it('marks unload and detach before invoking re-entrant lifecycle callbacks', () => {
		const calls = []
		const bridgeId = 'bridge-reentrant-unload'
		const page = {
			__id__: 'page',
			__type__: PageModule.type,
			pageUnload() {
				calls.push('page:unload')
				runtime.pageUnload({ bridgeId })
			},
			pageDetached: () => calls.push('page:detached'),
		}
		const child = {
			__id__: 'child',
			__parentId__: page.__id__,
			__type__: ComponentModule.type,
			__isComponent__: true,
			__componentAttached__: true,
			componentDetached() {
				calls.push('child:detached')
				runtime.moduleUnmounted({ bridgeId, moduleId: child.__id__ })
			},
		}
		runtime.instances[bridgeId] = { page, child }

		runtime.pageUnload({ bridgeId })

		expect(calls).toEqual([
			'page:unload',
			'child:detached',
			'page:detached',
		])
		expect(runtime.instances[bridgeId]).toBeUndefined()
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
