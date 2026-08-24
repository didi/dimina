import { CANVAS_CONTRACT_CHANGE_EVENT, CANVAS_OWNER_PROP } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { createApp, h, nextTick, provide, resolveComponent, resolveDirective, Suspense, withDirectives } from 'vue'
import Canvas from '../../components/src/component/canvas/Canvas.vue'
import { createMiniProgramSlots } from '../src/core/slots'

const CANVAS_ACTIVE_PROP = '__ddCanvasActive'

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
		document.body.classList.add('dd-page')
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
		expect(document.body.matches('.dd-page[data-v-app-style-scope][data-v-page-style-scope][data-v-shared-component-scope]')).toBe(true)
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
		expect(document.body.hasAttribute('data-v-app-style-scope')).toBe(false)
		expect(document.body.hasAttribute('data-v-page-style-scope')).toBe(false)
		expect(document.body.hasAttribute('data-v-shared-component-scope')).toBe(false)
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

	it('resolves a compiled canvas component host to its real canvas node', async () => {
		window.__message = {
			invoke: vi.fn(),
			off: vi.fn(),
			on: vi.fn(),
			send: vi.fn(),
		}
		window.__callback = {
			remove: vi.fn(),
			store: vi.fn(() => 'callback-id'),
		}
		runtime.ensureElementReady = async element => element
		runtime.canvasCapabilities = {}
		runtime.canvasNodes.clear()

		const host = document.createElement('div')
		document.body.append(host)
		const app = createApp({
			setup() {
				provide('bridgeId', 'bridge-1')
				provide('path', 'page-path')
				provide('page-path', { id: 'module-1' })
				return () => h(Canvas, {
					id: 'paint',
					canvasId: 'paint',
					renderHeight: 180,
					renderWidth: 320,
					type: 'webgl',
				})
			},
		})

		try {
			app.mount(host)
			await nextTick()
			const componentRoot = host.querySelector('#paint')
			const canvas = componentRoot.querySelector('canvas')
			componentRoot._ds = { purpose: 'chart' }
			Object.defineProperties(componentRoot, {
				offsetHeight: { configurable: true, value: 180 },
				offsetWidth: { configurable: true, value: 320 },
			})
			canvas.getBoundingClientRect = () => ({ height: 180, width: 320 })

			const result = await runtime.parseElement(componentRoot, {
				dataset: true,
				id: true,
				node: true,
				size: true,
			})

			expect(result.id).toBe('paint')
			expect(result.dataset).toEqual({ purpose: 'chart' })
			expect(result.width).toBe(320)
			expect(result.height).toBe(180)
			expect(result.node.__diminaNodeType).toBe('dimina-canvas-node')
			expect(result.node.type).toBe('webgl')
			expect(runtime.canvasNodes.get(result.node.nodeId)?.canvas).toBe(canvas)
		}
		finally {
			app.unmount()
			host.remove()
		}
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

	it('returns the real 2d property readback after applying a proxied setter', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		let fillStyle = '#000000'
		const context = {}
		Object.defineProperty(context, 'fillStyle', {
			get: () => fillStyle,
			set: (value) => {
				if (value !== 'var(--theme-color)') fillStyle = '#123456'
			},
		})
		const canvas = document.createElement('canvas')
		runtime.canvasNodes.set('canvas_state', { canvas, contexts: new Map([['ctx_state', context]]) })
		runtime.canvasResources.set('ctx_state', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_state',
			params: {
				nodeId: 'canvas_state',
				feedback: 'state_feedback',
				operations: [{
					op: 'contextSetProperty',
					contextId: 'ctx_state',
					prop: 'fillStyle',
					value: 'red',
					feedback: 'state',
					sequence: 7,
				}],
			},
		})

		const message = JSON.parse(window.DiminaRenderBridge.publish.mock.calls[0][0])
		expect(message.body.args.contexts.ctx_state.state).toEqual([
			{ prop: 'fillStyle', sequence: 7, value: '#123456' },
		])
	})

	it('does not turn an unsupported 2d property into a misleading expando', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		const context = {}
		const canvas = document.createElement('canvas')
		runtime.canvasNodes.set('canvas_unsupported_state', {
			canvas,
			contexts: new Map([['ctx_unsupported_state', context]]),
			resourceIds: new Set(['ctx_unsupported_state']),
		})
		runtime.canvasResources.set('ctx_unsupported_state', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_unsupported_state',
			params: {
				nodeId: 'canvas_unsupported_state',
				feedback: 'unsupported_state_feedback',
				operations: [{
					op: 'contextSetProperty',
					contextId: 'ctx_unsupported_state',
					prop: 'filter',
					value: 'blur(2px)',
					previousValue: 'none',
					feedback: 'state',
					sequence: 1,
				}],
			},
		})

		expect(context).not.toHaveProperty('filter')
		const message = JSON.parse(window.DiminaRenderBridge.publish.mock.calls[0][0])
		expect(message.body.args.contexts.ctx_unsupported_state.state).toEqual([
			{ prop: 'filter', sequence: 1, value: 'none' },
		])
	})

	it('falls back to backing-store reset when the host context has no reset method', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		const context = { fillStyle: 'red' }
		let width = 300
		const canvas = document.createElement('canvas')
		Object.defineProperty(canvas, 'width', {
			configurable: true,
			get: () => width,
			set: (value) => {
				width = value
				context.fillStyle = '#000000'
			},
		})
		runtime.canvasNodes.set('canvas_reset_fallback', {
			canvas,
			contexts: new Map([['ctx_reset_fallback', context]]),
			resourceIds: new Set(['ctx_reset_fallback']),
		})
		runtime.canvasResources.set('ctx_reset_fallback', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_reset_fallback',
			params: {
				nodeId: 'canvas_reset_fallback',
				feedback: 'reset_fallback_feedback',
				operations: [{
					op: 'contextCall',
					contextId: 'ctx_reset_fallback',
					method: 'reset',
					args: [],
					feedback: 'stateSnapshot',
					stateSequences: { fillStyle: 2 },
				}],
			},
		})

		expect(width).toBe(300)
		expect(context.fillStyle).toBe('#000000')
		const message = JSON.parse(window.DiminaRenderBridge.publish.mock.calls[0][0])
		expect(message.body.args.contexts.ctx_reset_fallback.state).toEqual([
			{ prop: 'fillStyle', sequence: 2, value: '#000000' },
		])
	})

	it('returns a full primitive 2d state snapshot after a state transition', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		const context = { fillStyle: '#000000', globalAlpha: 1 }
		const canvas = document.createElement('canvas')
		runtime.canvasNodes.set('canvas_snapshot', {
			canvas,
			contexts: new Map([['ctx_snapshot', context]]),
			resourceIds: new Set(['ctx_snapshot']),
		})
		runtime.canvasResources.set('ctx_snapshot', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_snapshot',
			params: {
				nodeId: 'canvas_snapshot',
				feedback: 'snapshot_feedback',
				operations: [{
					op: 'contextStateSnapshot',
					contextId: 'ctx_snapshot',
					stateSequences: { fillStyle: 3, globalAlpha: 4 },
					feedback: 'stateSnapshot',
				}],
			},
		})

		const message = JSON.parse(window.DiminaRenderBridge.publish.mock.calls[0][0])
		expect(message.body.args.contexts.ctx_snapshot.state).toEqual([
			{ prop: 'fillStyle', sequence: 3, value: '#000000' },
			{ prop: 'globalAlpha', sequence: 4, value: 1 },
		])
	})

	it('contains one failed canvas-node operation, reports it and continues the batch', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		const context = {
			fillRect: vi.fn(),
			getImageData: vi.fn(() => { throw new Error('tainted') }),
		}
		const canvas = document.createElement('canvas')
		canvas.getContext = vi.fn(() => context)
		runtime.canvasNodes.set('canvas_failure', { canvas, contexts: new Map([['ctx_failure', context]]) })
		runtime.canvasResources.set('ctx_failure', context)

		expect(() => runtime.canvasNodeFlush({
			bridgeId: 'bridge_failure',
			params: {
				nodeId: 'canvas_failure',
				feedback: 'flush_feedback',
				operations: [
					{
						op: 'getImageData',
						contextId: 'ctx_failure',
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						callback: 'pixel_callback',
						resultEnvelope: true,
					},
					{ op: 'contextCall', contextId: 'ctx_failure', method: 'fillRect', args: [0, 0, 1, 1] },
				],
			},
		})).not.toThrow()

		expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1, 1)
		const messages = window.DiminaRenderBridge.publish.mock.calls.map(([payload]) => JSON.parse(payload))
		expect(messages.find(message => message.body.id === 'pixel_callback').body.args)
			.toEqual({ ok: false, error: 'tainted' })
		expect(messages.some(message => message.body.id === 'flush_feedback')).toBe(true)
	})

	it('preserves canvas API order while an earlier request is still resolving its DOM node', async () => {
		runtime.canvasScopeQueues.clear()
		const canvas = document.createElement('canvas')
		let resolveFirstLookup
		const lookup = vi.spyOn(runtime, 'getCanvasElement')
			.mockImplementationOnce(() => new Promise(resolve => { resolveFirstLookup = resolve }))
			.mockResolvedValueOnce(canvas)
		const order = []
		const operation = vi.fn(async ({ params }) => { order.push(params.sequence) })

		try {
			const first = runtime.queueCanvasOperation({
				bridgeId: 'bridge_order',
				params: { canvasId: 'chart', moduleId: 'component_order', sequence: 'first' },
			}, operation)
			const second = runtime.queueCanvasOperation({
				bridgeId: 'bridge_order',
				params: { canvasId: 'chart', moduleId: 'component_order', sequence: 'second' },
			}, operation)

			await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
			resolveFirstLookup(canvas)
			await Promise.all([first, second])

			expect(order).toEqual(['first', 'second'])
			expect(lookup).toHaveBeenCalledTimes(2)
		}
		finally {
			lookup.mockRestore()
		}
	})

	it('releases the scope queue after lookup so different canvases can run independently', async () => {
		runtime.canvasScopeQueues.clear()
		runtime.canvasDrawQueues = new WeakMap()
		const firstCanvas = document.createElement('canvas')
		const secondCanvas = document.createElement('canvas')
		const lookup = vi.spyOn(runtime, 'getCanvasElement')
			.mockImplementation(canvasId => Promise.resolve(canvasId === 'first' ? firstCanvas : secondCanvas))
		let releaseFirst
		let markFirstStarted
		const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
		const firstBlocked = new Promise(resolve => { releaseFirst = resolve })
		const operation = vi.fn(async ({ params }) => {
			if (params.canvasId !== 'first') return
			markFirstStarted()
			await firstBlocked
		})

		const first = runtime.queueCanvasOperation({
			bridgeId: 'bridge_parallel',
			params: { canvasId: 'first', moduleId: 'component_parallel' },
		}, operation)
		const second = runtime.queueCanvasOperation({
			bridgeId: 'bridge_parallel',
			params: { canvasId: 'second', moduleId: 'component_parallel' },
		}, operation)

		try {
			await firstStarted
			await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2))
		}
		finally {
			releaseFirst()
			await Promise.all([first, second])
			lookup.mockRestore()
		}
	})

	it('reconstructs ImageData wire values with the target 2d context', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		const nativeImageData = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
		const context = {
			createImageData: vi.fn(() => nativeImageData),
			putImageData: vi.fn(),
		}
		const canvas = document.createElement('canvas')
		canvas.getContext = vi.fn(() => context)
		runtime.canvasNodes.set('canvas_image_data', { canvas, contexts: new Map([['ctx_image_data', context]]) })
		runtime.canvasResources.set('ctx_image_data', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_image_data',
			params: {
				nodeId: 'canvas_image_data',
				operations: [{
					op: 'contextCall',
					contextId: 'ctx_image_data',
					method: 'putImageData',
					args: [{ __canvasImageData: true, width: 1, height: 1, data: [9, 8, 7, 6] }, 2, 3],
				}],
			},
		})

		expect(context.createImageData).toHaveBeenCalledWith(1, 1)
		expect(Array.from(nativeImageData.data)).toEqual([9, 8, 7, 6])
		expect(context.putImageData).toHaveBeenCalledWith(nativeImageData, 2, 3)
	})

	it('does not resize a registered canvas node from an oversized layout rect', () => {
		runtime.canvasNodes.clear()
		const canvas = document.createElement('canvas')
		const setWidth = vi.fn()
		const setHeight = vi.fn()
		Object.defineProperties(canvas, {
			width: { configurable: true, get: () => 300, set: setWidth },
			height: { configurable: true, get: () => 150, set: setHeight },
		})
		canvas.getBoundingClientRect = vi.fn(() => ({ width: 100000, height: 100000 }))

		const node = runtime.registerCanvasNode(canvas)

		expect(setWidth).not.toHaveBeenCalled()
		expect(setHeight).not.toHaveBeenCalled()
		expect(node).toMatchObject({ width: 300, height: 150 })
	})

	it('preserves a zero backing size instead of substituting a rejected layout rect', () => {
		runtime.canvasNodes.clear()
		const canvas = document.createElement('canvas')
		const setWidth = vi.fn()
		const setHeight = vi.fn()
		Object.defineProperties(canvas, {
			width: { configurable: true, get: () => 0, set: setWidth },
			height: { configurable: true, get: () => 0, set: setHeight },
		})
		canvas.getBoundingClientRect = vi.fn(() => ({ width: 100000, height: 100000 }))

		const node = runtime.registerCanvasNode(canvas)

		expect(setWidth).not.toHaveBeenCalled()
		expect(setHeight).not.toHaveBeenCalled()
		expect(node).toMatchObject({ width: 0, height: 0 })
	})

	it('fails an oversized legacy draw before resizing its backing store', async () => {
		const canvas = document.createElement('canvas')
		const setWidth = vi.fn()
		const setHeight = vi.fn()
		Object.defineProperties(canvas, {
			width: { configurable: true, get: () => 300, set: setWidth },
			height: { configurable: true, get: () => 150, set: setHeight },
		})
		canvas.getBoundingClientRect = vi.fn(() => ({ width: 100000, height: 100000 }))
		canvas.getContext = vi.fn()
		const lookup = vi.spyOn(runtime, 'getCanvasElement').mockResolvedValue(canvas)
		const failure = vi.spyOn(runtime, 'triggerCanvasFailure')

		try {
			await runtime.drawCanvas({
				bridgeId: 'bridge_oversized_layout',
				params: { canvasId: 'oversized-layout', fail: 'draw-failed' },
			})

			expect(setWidth).not.toHaveBeenCalled()
			expect(setHeight).not.toHaveBeenCalled()
			expect(canvas.getContext).not.toHaveBeenCalled()
			expect(failure).toHaveBeenCalledWith(
				'bridge_oversized_layout',
				expect.any(Object),
				expect.stringContaining('maximum canvas bitmap'),
			)
		}
		finally {
			lookup.mockRestore()
			failure.mockRestore()
		}
	})

	it('reconstructs ImageData objects sent by a pre-tag canvas-node service', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		const nativeImageData = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
		const context = {
			createImageData: vi.fn(() => nativeImageData),
			putImageData: vi.fn(),
		}
		const canvas = document.createElement('canvas')
		runtime.canvasNodes.set('canvas_legacy_image_data', { canvas, contexts: new Map() })
		runtime.canvasResources.set('ctx_legacy_image_data', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_legacy_image_data',
			params: {
				nodeId: 'canvas_legacy_image_data',
				operations: [{
					op: 'contextCall',
					contextId: 'ctx_legacy_image_data',
					method: 'putImageData',
					args: [{
						width: 1,
						height: 1,
						data: { __canvasTypedArray: 'Uint8ClampedArray', data: [1, 2, 3, 4] },
					}, 5, 6],
				}],
			},
		})

		expect(Array.from(nativeImageData.data)).toEqual([1, 2, 3, 4])
		expect(context.putImageData).toHaveBeenCalledWith(nativeImageData, 5, 6)
	})

	it('keeps the pre-envelope getImageData callback payload shape for old service bundles', () => {
		runtime.canvasNodes.clear()
		runtime.canvasResources.clear()
		window.DiminaRenderBridge = { publish: vi.fn() }
		const context = {
			getImageData: vi.fn(() => ({ width: 1, height: 1, data: new Uint8ClampedArray([7, 8, 9, 10]) })),
		}
		const canvas = document.createElement('canvas')
		runtime.canvasNodes.set('canvas_legacy_pixels', { canvas, contexts: new Map() })
		runtime.canvasResources.set('ctx_legacy_pixels', context)

		runtime.canvasNodeFlush({
			bridgeId: 'bridge_legacy_pixels',
			params: {
				nodeId: 'canvas_legacy_pixels',
				operations: [{
					op: 'getImageData',
					contextId: 'ctx_legacy_pixels',
					x: 0,
					y: 0,
					width: 1,
					height: 1,
					callback: 'legacy_pixel_callback',
				}],
			},
		})

		const [payload] = window.DiminaRenderBridge.publish.mock.calls[0]
		expect(JSON.parse(payload).body.args).toEqual({ data: [7, 8, 9, 10], width: 1, height: 1 })
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

// canvas-id 的判重作用域是宿主组件实例，「页面一个、组件里一个」同名 canvas 合法共存。
// 页面作用域的查询会一路扫进组件内部，所以解析必须先认归属，不能按文档序取第一个。
describe('canvas element resolution', () => {
	let dom
	let runtime

	beforeEach(async () => {
		dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
		globalThis.window = dom.window
		globalThis.document = dom.window.document
		globalThis.Node = dom.window.Node
		globalThis.Element = dom.window.Element
		globalThis.HTMLElement = dom.window.HTMLElement
		globalThis.MutationObserver = dom.window.MutationObserver
		globalThis.navigator = dom.window.navigator

		const runtimeModule = await import('../src/core/runtime.js')
		runtime = runtimeModule.default
		runtime.pageId = 'page-1'
	})

	afterEach(() => {
		vi.restoreAllMocks()
		dom.window.close()
	})

	// 归属走 DOM property，名字与组件层写入时用的是同一个常量：分别写死字面量的话，
	// 任何一侧改名都不会让对方变红。
	function seedCanvases() {
		// 组件的 canvas 排在文档序更前面，按 querySelector 取第一个就会命中它。
		document.body.innerHTML = `
			<div id="component">
				<canvas class="in-component" canvas-id="chart"></canvas>
			</div>
			<canvas class="in-page" canvas-id="chart"></canvas>
		`
		document.querySelector('.in-component')[CANVAS_OWNER_PROP] = 'module-a_1'
		document.querySelector('.in-page')[CANVAS_OWNER_PROP] = 'page-1'
	}

	it('页面作用域命中页面自己的 canvas，而不是组件内的同名 canvas', async () => {
		seedCanvases()

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el?.[CANVAS_OWNER_PROP]).toBe('page-1')
	})

	it('传 bridgeId 当 moduleId 时同样按页面归属解析', async () => {
		seedCanvases()

		const el = await runtime.getCanvasElement('chart', 'bridge-1', 'bridge-1')

		expect(el?.[CANVAS_OWNER_PROP]).toBe('page-1')
	})

	it('归属不明确时回退到作用域内的第一个同名 canvas', async () => {
		document.body.innerHTML = '<canvas canvas-id="chart"></canvas>'

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el?.getAttribute('canvas-id')).toBe('chart')
	})

	it('页面没有自己的候选时不回退到显式属于组件的 canvas', async () => {
		document.body.innerHTML = '<div data-dd-component-host><canvas canvas-id="chart"></canvas></div>'
		const foreign = document.querySelector('canvas')
		foreign[CANVAS_OWNER_PROP] = 'module-a'
		foreign[CANVAS_ACTIVE_PROP] = true

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el).toBeNull()
	})

	it('legacy API 不会命中文档序更早的 typed canvas', async () => {
		document.body.innerHTML = `
			<canvas class="typed" type="2d" canvas-id="chart"></canvas>
			<canvas class="legacy" canvas-id="chart"></canvas>
		`
		for (const canvas of document.querySelectorAll('canvas')) {
			canvas[CANVAS_OWNER_PROP] = 'page-1'
			canvas[CANVAS_ACTIVE_PROP] = true
		}

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el?.className).toBe('legacy')
	})

	it('旧包页面查询排除组件私有子树中的 ownerless 同名 canvas', async () => {
		document.body.innerHTML = `
			<div data-dd-component-host><canvas class="old-component" canvas-id="chart"></canvas></div>
			<canvas class="old-page" canvas-id="chart"></canvas>
		`

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el?.className).toBe('old-page')
	})

	it('旧包组件根节点本身是 canvas 时仍在组件作用域内解析', async () => {
		document.body.innerHTML = '<canvas data-dd-component-host canvas-id="chart"></canvas>'
		const rootCanvas = document.querySelector('canvas')
		runtime.instance.set('module-old-root-canvas', { $el: rootCanvas })

		try {
			const el = await runtime.getCanvasElement('chart', 'module-old-root-canvas', 'bridge-1')

			expect(el).toBe(rootCanvas)
		}
		finally {
			runtime.instance.delete('module-old-root-canvas')
		}
	})

	it('只解析 active claim，不选择文档序更早的 rejected duplicate', async () => {
		document.body.innerHTML = `
			<canvas class="rejected" canvas-id="chart"></canvas>
			<canvas class="winner" canvas-id="chart"></canvas>
		`
		const rejected = document.querySelector('.rejected')
		const winner = document.querySelector('.winner')
		rejected[CANVAS_OWNER_PROP] = 'page-1'
		rejected[CANVAS_ACTIVE_PROP] = false
		winner[CANVAS_OWNER_PROP] = 'page-1'
		winner[CANVAS_ACTIVE_PROP] = true

		const el = await runtime.getCanvasElement('chart', null, 'bridge-1')

		expect(el?.className).toBe('winner')
	})

	it('把 canvas-id 当普通属性值比较，不能用联合 selector 改写查询', async () => {
		document.body.innerHTML = '<canvas class="victim" canvas-id="victim"></canvas>'
		const victim = document.querySelector('.victim')
		victim[CANVAS_OWNER_PROP] = 'page-1'
		victim[CANVAS_ACTIVE_PROP] = true

		const el = await runtime.getCanvasElement('x"], canvas[canvas-id="victim', null, 'bridge-1')

		expect(el).toBeNull()
	})

	it('等待中的 lookup 会响应既有 canvas 的 canvas-id 变化', async () => {
		document.body.innerHTML = '<canvas canvas-id="old"></canvas>'
		const canvas = document.querySelector('canvas')
		const pending = runtime.getCanvasElement('new', null, 'bridge-1')

		canvas.setAttribute('canvas-id', 'new')

		await expect(pending).resolves.toBe(canvas)
	})

	it('等待中的 legacy lookup 会响应既有 typed canvas 移除 type', async () => {
		document.body.innerHTML = '<canvas type="2d" canvas-id="chart"></canvas>'
		const canvas = document.querySelector('canvas')
		const pending = runtime.getCanvasElement('chart', null, 'bridge-1')

		canvas.removeAttribute('type')

		await expect(pending).resolves.toBe(canvas)
	})

	it('等待中的 lookup 会响应 inactive claim 在原节点上接手', async () => {
		document.body.innerHTML = '<canvas canvas-id="chart"></canvas>'
		const canvas = document.querySelector('canvas')
		canvas[CANVAS_OWNER_PROP] = 'page-1'
		canvas[CANVAS_ACTIVE_PROP] = false
		const pending = runtime.getCanvasElement('chart', null, 'bridge-1')

		canvas[CANVAS_ACTIVE_PROP] = true
		canvas.dispatchEvent(new window.Event(CANVAS_CONTRACT_CHANGE_EVENT, { bubbles: true }))

		await expect(pending).resolves.toBe(canvas)
	})
})
