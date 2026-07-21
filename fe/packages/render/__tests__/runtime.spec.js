import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { createApp, h, nextTick, provide, resolveComponent, resolveDirective, Suspense, withDirectives } from 'vue'
import { createMiniProgramSlots } from '../src/core/slots'

const groupA = [
	{ id: 1, name: 'Alice', score: 90 },
	{ id: 2, name: 'Bob', score: 85 },
	{ id: 3, name: 'Charlie', score: 78 },
]

const groupB = [
	{ id: 1, name: 'Dave', score: 92 },
	{ id: 2, name: 'Eve', score: 88 },
	{ id: 3, name: 'Frank', score: 71 },
]

describe('runtime template components', () => {
	let dom
	let runtime
	let applyWxmlStyleProperty
	let normalizeStaticBooleanAttributes

	beforeEach(async () => {
		dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
		globalThis.window = dom.window
		globalThis.document = dom.window.document
		globalThis.Node = dom.window.Node
		globalThis.Element = dom.window.Element
		globalThis.HTMLElement = dom.window.HTMLElement
		globalThis.SVGElement = dom.window.SVGElement
		globalThis.MutationObserver = dom.window.MutationObserver
		globalThis.navigator = dom.window.navigator
		globalThis.requestAnimationFrame = dom.window.requestAnimationFrame ?? (cb => setTimeout(cb, 0))
		globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame ?? (id => clearTimeout(id))

		const runtimeModule = await import('../src/core/runtime.js')
		runtime = runtimeModule.default
		applyWxmlStyleProperty = runtimeModule.applyWxmlStyleProperty
		normalizeStaticBooleanAttributes = runtimeModule.normalizeStaticBooleanAttributes
	})

	afterEach(() => {
		vi.restoreAllMocks()
		dom.window.close()
		delete globalThis.window
		delete globalThis.document
		delete globalThis.Node
		delete globalThis.Element
		delete globalThis.HTMLElement
		delete globalThis.SVGElement
		delete globalThis.MutationObserver
		delete globalThis.navigator
		delete globalThis.requestAnimationFrame
		delete globalThis.cancelAnimationFrame
	})

	it('reconstructs collapsed component roots in exparser bubble order', () => {
		const page = {}
		const parent = {}
		const target = {}
		const basicNode = {}
		runtime.moduleIds = new WeakMap([
			[page, 'page-id'],
			[parent, 'parent-id'],
			[target, 'target-id'],
		])

		const parentRoot = document.createElement('div')
		parentRoot.id = 'parent-root'
		const targetRoot = document.createElement('div')
		targetRoot.id = 'target-root'
		parentRoot.append(targetRoot)
		document.body.append(parentRoot)
		targetRoot._ddEventBindings = [
			{
				owner: target,
				target: basicNode,
				nodeType: 'node',
				eventAttr: { custom: { bind: 'targetInternal' } },
			},
			{
				owner: page,
				target,
				nodeType: 'component',
				eventAttr: { custom: { bind: 'targetHost' } },
			},
		]
		// 故意按宿主 -> 内部节点存放，收集时仍应按内 -> 外排序。
		parentRoot._ddEventBindings = [
			{
				owner: page,
				target: parent,
				nodeType: 'component',
				eventAttr: { custom: { bind: 'parentHost' } },
			},
			{
				owner: parent,
				target: basicNode,
				nodeType: 'node',
				eventAttr: { custom: { bind: 'parentInternal' } },
			},
		]

		expect(runtime.collectCustomEventPath(targetRoot, 'target-id')).toEqual([
			expect.objectContaining({
				moduleId: 'parent-id',
				isComponentHost: false,
				eventAttr: { custom: { bind: 'parentInternal' } },
			}),
			expect.objectContaining({
				moduleId: 'page-id',
				nodeModuleId: 'parent-id',
				isComponentHost: true,
				eventAttr: { custom: { bind: 'parentHost' } },
			}),
		])
	})

	it('resolves a slotted component parent from the rendered element tree', () => {
		const parentRoot = document.createElement('div')
		const childRoot = document.createElement('div')
		parentRoot.append(childRoot)
		document.body.append(parentRoot)

		runtime.moduleRootIds = new WeakMap()
		runtime.registerModuleRoots('child-id', [childRoot])
		runtime.registerModuleRoots('parent-id', [parentRoot])

		expect(runtime.getRenderParentModuleId([childRoot], 'child-id')).toBe('parent-id')
	})

	it('maps the raw WXML host style back to a declared component property', () => {
		expect(applyWxmlStyleProperty(
			{ style: { type: String } },
			{ style: '', diminaWxmlStyle: 'height: 488rpx' },
			{ props: { 'dimina-wxml-style': 'height: 488rpx' } },
		)).toEqual({ style: 'height: 488rpx' })

		expect(applyWxmlStyleProperty(
			{},
			{ diminaWxmlStyle: 'height: 488rpx' },
			{ props: { 'dimina-wxml-style': 'height: 488rpx' } },
		)).toEqual({})
	})

	it('sends the raw WXML style when creating a component that declares style', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		let createdMessage
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') return
				createdMessage = sent.body
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: { style: sent.body.properties.style } },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockReturnValue({
			moduleInfo: {
				id: 'styled-child',
				usingComponents: {},
				render() {
					return h('div', { class: 'styled-child', style: this.style }, 'styled')
				},
			},
			propertySchemas: {
				style: { type: String, optionalTypes: [], value: '' },
			},
			props: {
				style: { type: null },
			},
		})

		const StyledChild = runtime.createComponent('/pages/style/index', 'bridge-style', {
			child: '/components/styled-child',
		})['dd-child']
		const styledChildRef = ref()
		const app = createApp({
			setup() {
				provide('info', { id: 'page-id', sId: 'page-scope' })
				provide('path', '/pages/style/index')
				provide('/pages/style/index', { id: 'page-id' })
				return () => h(Suspense, null, {
					default: () => h(StyledChild, {
						ref: styledChildRef,
						'dimina-wxml-style': 'height: 488rpx',
					}),
				})
			},
		})
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)

		await vi.waitFor(() => expect(root.textContent).toBe('styled'))
		expect(styledChildRef.value.props.diminaWxmlStyle).toBe('height: 488rpx')
		expect(createdMessage.properties.style).toBe('height: 488rpx')
		expect(createdMessage.propertyNames).toContain('style')

		app.unmount()
	})

	it('renders top-level data keys that are added after initial component data', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let moduleId
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') return
				moduleId = sent.body.moduleId
				window.DiminaRenderBridge.onMessage({
					type: moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockReturnValue({
			moduleInfo: {
				id: 'late-data-child',
				usingComponents: {},
				render() {
					return h('div', this.lateValue)
				},
			},
			propertySchemas: {},
			props: {},
		})

		const LateDataChild = runtime.createComponent('/pages/late-data/index', 'bridge-late-data', {
			child: '/components/late-data-child',
		})['dd-child']
		const app = createApp({
			setup() {
				provide('info', { id: 'page-id', sId: 'page-scope' })
				provide('path', '/pages/late-data/index')
				provide('/pages/late-data/index', { id: 'page-id' })
				return () => h(Suspense, null, {
					default: () => h(LateDataChild),
				})
			},
		})
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)

		await vi.waitFor(() => expect(moduleId).toBeDefined())
		runtime.updateModule({
			moduleId,
			data: { lateValue: 'ready' },
		})
		await vi.waitFor(() => expect(root.textContent).toBe('ready'))
		expect(warn.mock.calls.flat().join('\n')).not.toContain('Property "lateValue" was accessed during render')

		app.unmount()
	})

	it('keeps a self-declared custom component available to its own render definition', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const componentPath = '/components/tree-node'
		const getModule = vi.spyOn(loader, 'getModuleByPath').mockReturnValue({
			moduleInfo: {
				id: 'tree-node',
				usingComponents: {
					'tree-node': componentPath,
				},
				render() {},
			},
			propertySchemas: {},
			props: {},
		})

		const components = runtime.createComponent('/pages/tree/index', 'bridge-tree', {
			'tree-node': componentPath,
		})
		const pageTreeNode = components['dd-tree-node']
		const recursiveTreeNode = pageTreeNode.components['dd-tree-node']

		expect(recursiveTreeNode).toBeDefined()
		expect(recursiveTreeNode).not.toBe(pageTreeNode)
		expect(recursiveTreeNode.components['dd-tree-node']).toBe(recursiveTreeNode)
		expect(getModule).toHaveBeenCalledTimes(2)
	})

	it('closes mutually recursive component definitions without dropping either edge', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const modules = {
			'/components/node-a': {
				moduleInfo: {
					id: 'node-a',
					usingComponents: { 'node-b': '/components/node-b' },
					render() {},
				},
				propertySchemas: {},
				props: {},
			},
			'/components/node-b': {
				moduleInfo: {
					id: 'node-b',
					usingComponents: { 'node-a': '/components/node-a' },
					render() {},
				},
				propertySchemas: {},
				props: {},
			},
		}
		vi.spyOn(loader, 'getModuleByPath').mockImplementation(path => modules[path])

		const components = runtime.createComponent('/pages/mutual/index', 'bridge-mutual', {
			'node-a': '/components/node-a',
		})
		const rootA = components['dd-node-a']
		const nestedB = rootA.components['dd-node-b']
		const nestedA = nestedB.components['dd-node-a']

		expect(nestedA.components['dd-node-b']).toBe(nestedB)
	})

	it('uses a declared placeholder only while the target component module is unavailable', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const targetPath = '/components/async-card'
		const placeholderPath = '/components/loading-card'
		const modules = {
			[placeholderPath]: {
				moduleInfo: {
					id: 'loading-card',
					usingComponents: {},
					componentPlaceholder: {},
					render() {},
				},
				propertySchemas: {},
				props: {},
			},
		}
		vi.spyOn(loader, 'getModuleByPath').mockImplementation(path => modules[path])
		const usingComponents = {
			'async-card': targetPath,
			'loading-card': placeholderPath,
		}
		const componentPlaceholder = {
			'async-card': 'loading-card',
		}

		const waiting = runtime.createComponent(
			'/pages/placeholder/index',
			'bridge-placeholder',
			usingComponents,
			new Map(),
			componentPlaceholder,
		)
		expect(waiting['dd-async-card']).toBe(waiting['dd-loading-card'])
		expect(waiting['dd-async-card'].name).toBe(placeholderPath)

		modules[targetPath] = {
			moduleInfo: {
				id: 'async-card',
				usingComponents: {},
				componentPlaceholder: {},
				render() {},
			},
			propertySchemas: {},
			props: {},
		}
		const loaded = runtime.createComponent(
			'/pages/loaded/index',
			'bridge-loaded',
			usingComponents,
			new Map(),
			componentPlaceholder,
		)
		expect(loaded['dd-async-card']).not.toBe(loaded['dd-loading-card'])
		expect(loaded['dd-async-card'].name).toBe(targetPath)
	})

	it('uses the actual owner when a template reuses a component definition from another tree', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		const createdMessages = []
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') {
					return
				}
				createdMessages.push(sent.body)
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockImplementation((path) => {
			if (path !== '/shared/child') {
				return undefined
			}
			return {
				moduleInfo: {
					id: 'shared-child',
					usingComponents: {},
					render() {
						return h('div', { class: 'shared-child' }, 'ready')
					},
				},
				propertySchemas: {},
				props: {},
			}
		})

		// This definition was built while traversing /registered/parent, but a
		// globally registered template renders it below /actual/parent.
		const components = runtime.createComponent('/registered/parent', 'bridge-template', {
			child: '/shared/child',
		})
		const ReusedChild = components['dd-child']
		const app = createApp({
			setup() {
				provide('info', { id: 'actual-parent-id', sId: 'actual-parent-scope' })
				provide('path', '/actual/parent')
				provide('/actual/parent', { id: 'actual-parent-id' })
				return () => h(Suspense, null, {
					default: () => h(ReusedChild),
				})
			},
		})
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		await nextTick()

		await vi.waitFor(() => expect(root.textContent).toBe('ready'))
		expect(createdMessages).toHaveLength(1)
		expect(createdMessages[0]).toMatchObject({
			parentId: 'actual-parent-id',
			pageId: 'actual-parent-id',
		})

		app.unmount()
	})

	it('treats static valueless Boolean component properties as true', () => {
		const schemas = {
			loading: { type: Boolean, optionalTypes: [], value: false },
			label: { type: String, optionalTypes: [], value: '' },
		}

		expect(normalizeStaticBooleanAttributes(schemas, { loading: '', label: '' }, {
			props: { loading: '', label: '' },
			dynamicProps: null,
		})).toEqual({ loading: true, label: '' })
		expect(normalizeStaticBooleanAttributes(schemas, { loading: '', label: '' }, {
			props: { loading: '', label: '' },
			dynamicProps: ['loading'],
		})).toEqual({ loading: '', label: '' })
	})

	it('keeps the lexical event owner for a component rendered through a slot', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		const createdMessages = []
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') {
					return
				}
				createdMessages.push(sent.body)
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockImplementation((path) => {
			if (path !== '/shared/child') {
				return undefined
			}
			return {
				moduleInfo: {
					id: 'shared-child',
					usingComponents: {},
					render() {
						return h('div', { class: 'shared-child' }, 'ready')
					},
				},
				propertySchemas: {},
				props: {},
			}
		})

		const components = runtime.createComponent('/slot/owner', 'bridge-slot', {
			child: '/shared/child',
		})
		const SlottedChild = components['dd-child']
		const app = createApp({
			setup() {
				provide('info', { id: 'render-parent-id', sId: 'render-parent-scope' })
				provide('path', '/render/parent')
				provide('/render/parent', { id: 'render-parent-id' })
				provide('/slot/owner', { id: 'slot-owner-id' })
				return () => h(Suspense, null, {
					default: () => h(SlottedChild),
				})
			},
		})
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		await nextTick()

		await vi.waitFor(() => expect(root.textContent).toBe('ready'))
		expect(createdMessages).toHaveLength(1)
		expect(createdMessages[0]).toMatchObject({
			parentId: 'render-parent-id',
			pageId: 'slot-owner-id',
		})

		app.unmount()
	})

	it('keeps external classes on the lexical component scope through a slot', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') {
					return
				}
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockImplementation((path) => {
			if (path !== '/shared/image') {
				return undefined
			}
			return {
				moduleInfo: {
					id: 'image-component-scope',
					usingComponents: {},
					render() {
						const captureScope = resolveDirective('capture-external-class-scope')
						return withDirectives(h('div', { class: 'external-image' }, 'image'), [[captureScope]])
					},
				},
				propertySchemas: {},
				props: {},
			}
		})

		const components = runtime.createComponent('/components/grid-item', 'bridge-external-class', {
			image: '/shared/image',
		})
		const SlottedImage = components['dd-image']
		const app = createApp({
			setup() {
				// Simulates grid-item content rendered below a badge slot. The nearest
				// render parent has another scope, while the vnode keeps grid-item's scope.
				provide('info', { id: 'badge-id', sId: 'data-v-badge-scope' })
				provide('path', '/components/badge')
				provide('/components/badge', { id: 'badge-id' })
				provide('/components/grid-item', { id: 'grid-item-id' })
				return () => h(Suspense, null, {
					default: () => {
						const child = h(SlottedImage)
						child.scopeId = 'data-v-grid-item-scope'
						child.slotScopeIds = ['data-v-badge-scope-s']
						return child
					},
				})
			},
		})
		app.directive('capture-external-class-scope', {
			mounted(el, binding) {
				el.setAttribute('data-external-class-scope', binding.instance.sId)
			},
		})
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)

		await vi.waitFor(() => expect(root.textContent).toBe('image'))
		const image = root.querySelector('.external-image')
		expect(image.getAttribute('data-external-class-scope')).toBe('data-v-grid-item-scope')
		expect(image.getAttribute('data-external-class-scope')).not.toBe('data-v-badge-scope')

		app.unmount()
	})

	it('mounts the compiled custom tabBar as a sibling of the tab page', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		const createdMessages = []
		window.DiminaRenderBridge = {
			invoke: vi.fn(),
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') {
					return
				}
				createdMessages.push(sent.body)
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockImplementation((path) => {
			if (path === 'pages/home/index') {
				return {
					moduleInfo: {
						id: 'home-page',
						usingComponents: {
							tabBarAlias: '/custom-tab-bar/index',
						},
						customTabBar: { componentName: 'tabBarAlias' },
						tplComponents: {},
						render() {
							return h('main', { class: 'page-content' }, 'page')
						},
					},
				}
			}
			if (path === '/custom-tab-bar/index') {
				return {
					moduleInfo: {
						id: 'custom-tab-bar',
						usingComponents: {},
						customTabBar: true,
						render() {
							return h('footer', { class: 'custom-tab-bar' }, 'icons')
						},
					},
					propertySchemas: {},
					props: {},
				}
			}
		})

		const options = runtime.makeOptions({
			path: 'pages/home/index',
			bridgeId: 'bridge-custom-tab-bar',
			pageId: 'page-custom-tab-bar',
		})
		const app = createApp(options.app)
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		window.DiminaRenderBridge.onMessage({
			type: 'page-custom-tab-bar',
			body: { data: {} },
		})

		await vi.waitFor(() => expect(root.textContent).toBe('pageicons'))
		expect(root.querySelector('.page-content')).not.toBeNull()
		expect(root.querySelector('.custom-tab-bar')).not.toBeNull()
		expect(createdMessages).toHaveLength(1)
		expect(createdMessages[0].isCustomTabBar).toBe(true)

		app.unmount()
	})

	it('applies page and app styles only inside apply-shared components', async () => {
		const loader = (await import('../src/core/loader.js')).default
		const message = (await import('../src/core/message.js')).default
		window.DiminaRenderBridge = {
			invoke: vi.fn(),
			publish: vi.fn((payload) => {
				const sent = JSON.parse(payload)
				if (sent.type !== 'mC') {
					return
				}
				window.DiminaRenderBridge.onMessage({
					type: sent.body.moduleId,
					body: { data: {} },
				})
			}),
		}
		message.init()

		vi.spyOn(loader, 'getModuleByPath').mockImplementation((path) => {
			if (path === 'pages/style/index') {
				return {
					moduleInfo: {
						id: 'page-style-scope',
						appStyleScopeId: 'app-style-scope',
						sharedStyleScopeIds: ['shared-component-scope'],
						usingComponents: {
							applied: '/components/applied',
							shared: '/components/shared',
							isolated: '/components/isolated',
						},
						tplComponents: {},
						render() {
							const Applied = resolveComponent('dd-applied')
							const Shared = resolveComponent('dd-shared')
							const Isolated = resolveComponent('dd-isolated')
							return h('main', { class: 'style-page' }, [
								h(Applied),
								h(Shared),
								h(Isolated),
							])
						},
					},
				}
			}
			if (path === '/components/applied') {
				return {
					moduleInfo: {
						id: 'applied-style-scope',
						styleIsolation: 'apply-shared',
						usingComponents: {},
						render() {
							return h('section', { class: 'applied-host' }, [
								h('div', { class: 'applied-inner' }, 'applied'),
							])
						},
					},
					propertySchemas: {},
					props: {},
				}
			}
			if (path === '/components/shared') {
				return {
					moduleInfo: {
						id: 'shared-component-scope',
						styleIsolation: 'shared',
						usingComponents: {},
						render() {
							return h('section', { class: 'shared-host' }, [
								h('div', { class: 'shared-inner' }, 'shared'),
							])
						},
					},
					propertySchemas: {},
					props: {},
				}
			}
			if (path === '/components/isolated') {
				return {
					moduleInfo: {
						id: 'isolated-style-scope',
						styleIsolation: 'isolated',
						usingComponents: {},
						render() {
							return h('section', { class: 'isolated-host' }, [
								h('div', { class: 'isolated-inner' }, 'isolated'),
							])
						},
					},
					propertySchemas: {},
					props: {},
				}
			}
		})

		const options = runtime.makeOptions({
			path: 'pages/style/index',
			bridgeId: 'bridge-style-isolation',
			pageId: 'page-style-isolation',
		})
		const app = createApp(options.app)
		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		window.DiminaRenderBridge.onMessage({
			type: 'page-style-isolation',
			body: { data: {} },
		})

		await vi.waitFor(() => expect(root.textContent).toBe('appliedsharedisolated'))
		const page = root.querySelector('.style-page')
		const appliedHost = root.querySelector('.applied-host')
		const appliedInner = root.querySelector('.applied-inner')
		const sharedHost = root.querySelector('.shared-host')
		const sharedInner = root.querySelector('.shared-inner')
		const isolatedHost = root.querySelector('.isolated-host')
		const isolatedInner = root.querySelector('.isolated-inner')
		await vi.waitFor(() => expect(appliedInner.hasAttribute('data-v-app-style-scope')).toBe(true))
		expect(appliedHost.getAttribute('data-dd-style-isolation')).toBe('apply-shared')
		expect(appliedHost.getAttribute('data-dd-style-host')).toBe('applied-style-scope')
		expect(appliedInner.hasAttribute('data-dd-style-host')).toBe(false)
		expect(page.hasAttribute('data-dd-style-host')).toBe(false)
		expect([page, appliedHost, appliedInner, sharedHost, sharedInner, isolatedHost].map(element => ({
			className: element.className,
			app: element.hasAttribute('data-v-app-style-scope'),
			page: element.hasAttribute('data-v-page-style-scope'),
			shared: element.hasAttribute('data-v-shared-component-scope'),
		}))).toEqual([
			{ className: 'style-page', app: true, page: true, shared: true },
			{ className: 'applied-host', app: true, page: true, shared: true },
			{ className: 'applied-inner', app: true, page: true, shared: true },
			{ className: 'shared-host', app: true, page: true, shared: true },
			{ className: 'shared-inner', app: true, page: true, shared: true },
			{ className: 'isolated-host', app: true, page: true, shared: true },
		])
		expect(appliedHost.getAttribute('data-dd-style-isolation')).toBe('apply-shared')
		expect(sharedHost.getAttribute('data-dd-style-isolation')).toBe('shared')
		expect(sharedHost.getAttribute('data-dd-style-host')).toBe('shared-component-scope')
		expect(sharedInner.hasAttribute('data-dd-style-host')).toBe(false)
		expect(isolatedHost.getAttribute('data-dd-style-isolation')).toBe('isolated')
		expect(isolatedInner.hasAttribute('data-v-app-style-scope')).toBe(false)
		expect(isolatedInner.hasAttribute('data-v-page-style-scope')).toBe(false)
		expect(isolatedInner.hasAttribute('data-v-shared-component-scope')).toBe(false)

		const dynamicApplied = document.createElement('div')
		appliedInner.append(dynamicApplied)
		const dynamicIsolated = document.createElement('div')
		isolatedInner.append(dynamicIsolated)
		await vi.waitFor(() => expect(dynamicApplied.hasAttribute('data-v-page-style-scope')).toBe(true))
		expect(dynamicApplied.hasAttribute('data-v-app-style-scope')).toBe(true)
		expect(dynamicIsolated.hasAttribute('data-v-app-style-scope')).toBe(false)
		expect(dynamicIsolated.hasAttribute('data-v-page-style-scope')).toBe(false)

		const nestedAppliedHost = document.createElement('section')
		nestedAppliedHost.setAttribute('data-dd-component-host', '')
		nestedAppliedHost.setAttribute('data-dd-style-isolation', 'apply-shared')
		const nestedAppliedInner = document.createElement('div')
		nestedAppliedHost.append(nestedAppliedInner)
		isolatedInner.append(nestedAppliedHost)
		await vi.waitFor(() => expect(nestedAppliedInner.hasAttribute('data-v-app-style-scope')).toBe(true))

		const nestedIsolatedHost = document.createElement('section')
		nestedIsolatedHost.setAttribute('data-dd-component-host', '')
		nestedIsolatedHost.setAttribute('data-dd-style-isolation', 'isolated')
		const nestedIsolatedInner = document.createElement('div')
		nestedIsolatedHost.append(nestedIsolatedInner)
		appliedInner.append(nestedIsolatedHost)
		await vi.waitFor(() => expect(nestedIsolatedHost.hasAttribute('data-v-app-style-scope')).toBe(true))
		expect(nestedIsolatedInner.hasAttribute('data-v-app-style-scope')).toBe(false)

		app.unmount()
	})

	it('syncs template data when keyed list items are replaced', async () => {
		const TplItem = runtime.createTplComponent({
			id: 'tpl-item',
			render() {
				return h('div', { class: 'item' }, [
					h('span', { class: 'item-name' }, this.name),
					h('span', { class: 'item-score' }, `Score: ${this.score}`),
				])
			},
		})

		const state = { list: groupA }
		const app = createApp({
			data: () => state,
			render() {
				return h(
					'div',
					{ class: 'list' },
					this.list.map(item => h(TplItem, { key: item.id, data: item })),
				)
			},
		})

		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)

		expect(root.textContent).toContain('Alice')
		expect(root.textContent).toContain('Charlie')

		state.list = groupB
		app._instance.update()
		await nextTick()

		expect(root.textContent).toContain('Dave')
		expect(root.textContent).toContain('Eve')
		expect(root.textContent).toContain('Frank')
		expect(root.textContent).not.toContain('Alice')
		expect(root.textContent).not.toContain('Charlie')

		app.unmount()
	})

	it('treats missing template data fields as undefined', async () => {
		const warnings = []
		const TplHead = runtime.createTplComponent({
			id: 'tpl-head',
			render() {
				return h('div', [
					h('span', { class: 'head-title' }, this.title),
					this.desc ? h('span', { class: 'head-desc' }, this.desc) : null,
				])
			},
		})

		const app = createApp({
			render() {
				return h(TplHead, { data: { title: 'swiper' } })
			},
		})
		app.config.warnHandler = (message) => {
			warnings.push(message)
		}

		const root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		await nextTick()

		expect(root.textContent).toBe('swiper')
		expect(warnings).toEqual([])

		app.unmount()
	})

	it('returns a serializable canvas node from selector node fields', async () => {
		runtime.ensureElementReady = async element => element
		runtime.canvasNodes.clear()

		const canvas = document.createElement('canvas')
		canvas.setAttribute('type', 'webgl')
		canvas.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			right: 300,
			bottom: 300,
			width: 300,
			height: 300,
		}))
		document.body.append(canvas)

		const result = await runtime.parseElement(canvas, {
			node: true,
			size: true,
		})

		expect(result.node.__diminaNodeType).toBe('dimina-canvas-node')
		expect(result.node.type).toBe('webgl')
		expect(result.node.width).toBe(300)
		expect(result.node.height).toBe(300)
		expect(canvas.width).toBe(300)
		expect(canvas.height).toBe(300)
		expect(runtime.canvasNodes.has(result.node.nodeId)).toBe(true)

		canvas.width = 600
		canvas.height = 600
		const nextResult = await runtime.parseElement(canvas, {
			node: true,
		})
		expect(nextResult.node.width).toBe(600)
		expect(nextResult.node.height).toBe(600)
		expect(canvas.width).toBe(600)
		expect(canvas.height).toBe(600)
	})

	it('replays canvas node webgl operations against the real context', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()

		const shader = { kind: 'shader' }
		const gl = {
			VERTEX_SHADER: 0x8B31,
			createShader: vi.fn(() => shader),
			shaderSource: vi.fn(),
			compileShader: vi.fn(),
			viewport: vi.fn(),
		}
		const canvas = document.createElement('canvas')
		canvas.getContext = vi.fn(() => gl)
		runtime.canvasNodes.set('canvas_1', {
			canvas,
			contexts: new Map(),
		})

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_1',
			params: {
				nodeId: 'canvas_1',
				operations: [
					{ op: 'setCanvasProperty', prop: 'width', value: 600 },
					{ op: 'getContext', contextId: 'ctx_1', contextType: 'webgl' },
					{ op: 'contextCall', contextId: 'ctx_1', method: 'viewport', args: [0, 0, 300, 150] },
					{ op: 'contextCall', contextId: 'ctx_1', method: 'createShader', args: [0x8B31], resultId: 'shader_1' },
					{
						op: 'contextCall',
						contextId: 'ctx_1',
						method: 'shaderSource',
						args: [{ __canvasResourceId: 'shader_1' }, 'void main() {}'],
					},
					{
						op: 'contextCall',
						contextId: 'ctx_1',
						method: 'compileShader',
						args: [{ __canvasResourceId: 'shader_1' }],
					},
				],
			},
		})

		expect(canvas.width).toBe(600)
		expect(canvas.getContext).toHaveBeenCalledWith('webgl', undefined)
		expect(gl.viewport).toHaveBeenCalledWith(0, 0, 300, 150)
		expect(gl.shaderSource).toHaveBeenCalledWith(shader, 'void main() {}')
		expect(gl.compileShader).toHaveBeenCalledWith(shader)
	})

	it('returns real webgl creation, diagnostics, errors and typed-array feedback', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }

		const shader = { kind: 'shader' }
		const errors = [0x0502, 0]
		const gl = {
			NO_ERROR: 0,
			INVALID_OPERATION: 0x0502,
			VERTEX_SHADER: 0x8B31,
			FRAGMENT_SHADER: 0x8B30,
			SHADER_TYPE: 0x8B4F,
			COMPILE_STATUS: 0x8B81,
			LOW_FLOAT: 0x8DF0,
			MEDIUM_FLOAT: 0x8DF1,
			HIGH_FLOAT: 0x8DF2,
			LOW_INT: 0x8DF3,
			MEDIUM_INT: 0x8DF4,
			HIGH_INT: 0x8DF5,
			drawingBufferWidth: 2,
			drawingBufferHeight: 1,
			getParameter: vi.fn(() => 4096),
			getSupportedExtensions: vi.fn(() => []),
			getContextAttributes: vi.fn(() => ({ alpha: false, preserveDrawingBuffer: true })),
			getShaderPrecisionFormat: vi.fn(() => ({ rangeMin: 127, rangeMax: 127, precision: 23 })),
			isContextLost: vi.fn(() => false),
			getError: vi.fn(() => errors.shift() ?? 0),
			createShader: vi.fn(() => shader),
			compileShader: vi.fn(),
			getShaderParameter: vi.fn((_shader, pname) => pname === 0x8B4F ? 0x8B31 : false),
			getShaderInfoLog: vi.fn(() => 'shader compilation failed'),
			readPixels: vi.fn((_x, _y, _width, _height, _format, _type, output) => {
				output.set([1, 2, 3, 4, 5, 6, 7, 8])
			}),
		}
		const canvas = document.createElement('canvas')
		canvas.getContext = vi.fn(() => gl)
		runtime.canvasNodes.set('canvas_feedback', {
			canvas,
			contexts: new Map(),
		})

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_feedback',
			params: {
				nodeId: 'canvas_feedback',
				feedback: 'feedback_callback',
				operations: [
					{
						op: 'getContext',
						contextId: 'context_feedback',
						contextType: 'webgl',
						attributes: { alpha: false },
					},
					{
						op: 'contextCall',
						contextId: 'context_feedback',
						method: 'createShader',
						args: [0x8B31],
						resultId: 'shader_feedback',
					},
					{
						op: 'contextCall',
						contextId: 'context_feedback',
						method: 'compileShader',
						args: [{ __canvasResourceId: 'shader_feedback' }],
						feedback: 'shader',
					},
					{
						op: 'contextCall',
						contextId: 'context_feedback',
						method: 'readPixels',
						args: [
							0,
							0,
							2,
							1,
							0x1908,
							0x1401,
							{ __canvasTypedArray: 'Uint8Array', data: Array.from({ length: 8 }, () => 0) },
						],
						typedArrayUpdateId: 'pixels_feedback',
						typedArrayArgIndex: 6,
					},
				],
			},
		})

		expect(canvas.getContext).toHaveBeenCalledWith('webgl', { alpha: false })
		expect(gl.compileShader).toHaveBeenCalledWith(shader)
		expect(gl.readPixels).toHaveBeenCalledTimes(1)
		const message = JSON.parse(window.DiminaRenderBridge.publish.mock.calls[0][0])
		const feedback = message.body.args
		expect(message.body.id).toBe('feedback_callback')
		expect(feedback.contexts.context_feedback.success).toBe(true)
		expect(feedback.contexts.context_feedback.capabilities.contextAttributes).toEqual({
			alpha: false,
			preserveDrawingBuffer: true,
		})
		expect(feedback.contexts.context_feedback.resources[0]).toEqual({
			resourceId: 'shader_feedback',
			metadata: {
				shaderType: 0x8B31,
				compileStatus: false,
				infoLog: 'shader compilation failed',
			},
		})
		expect(feedback.contexts.context_feedback.errors).toEqual([0x0502])
		expect(feedback.typedArrays[0].value.data).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
	})

	it('applies service path arrays without re-parsing escaped setData keys', () => {
		const moduleId = 'module-path-array'
		const data = {}
		runtime.setupData.set(moduleId, data)
		runtime.initializedModules.add(moduleId)

		runtime.updateModule({
			moduleId,
			data: {
				'a\\.b.value': 1,
				'list[1].name': 'second',
			},
			changes: [
				{ path: ['a.b', 'value'], value: 1 },
				{ path: ['list', 1, 'name'], value: 'second' },
			],
		})

		expect(data).toEqual({
			'a.b': { value: 1 },
			list: [undefined, { name: 'second' }],
		})

		runtime.setupData.delete(moduleId)
		runtime.initializedModules.delete(moduleId)
	})

	it('makes late-added top-level data available through the component proxy', () => {
		const moduleId = 'module-late-key'
		const data = {}
		const update = vi.fn()
		const instance = {
			$: {
				accessCache: { lateValue: 0 },
				ctx: {},
				update,
			},
		}
		runtime.setupData.set(moduleId, data)
		runtime.initializedModules.add(moduleId)
		runtime.instance.set(moduleId, instance)

		runtime.updateModule({
			moduleId,
			data: { lateValue: 'ready' },
		})

		expect(data.lateValue).toBe('ready')
		expect(instance.$.accessCache).not.toHaveProperty('lateValue')
		expect(instance.$.ctx.lateValue).toBe('ready')
		expect(update).toHaveBeenCalledOnce()

		runtime.instance.delete(moduleId)
		runtime.setupData.delete(moduleId)
		runtime.initializedModules.delete(moduleId)
	})
})

describe('mini-program dynamic slots', () => {
	it('merges duplicate slot functions in declaration order', () => {
		const slots = createMiniProgramSlots({}, [
			{ name: 'info', fn: () => ['success'] },
			[
				{ name: 'info', fn: () => ['failure'] },
				{ name: 'footer', fn: () => ['footer'] },
			],
		])

		expect(slots.info()).toEqual(['success', 'failure'])
		expect(slots.footer()).toEqual(['footer'])
	})
})
