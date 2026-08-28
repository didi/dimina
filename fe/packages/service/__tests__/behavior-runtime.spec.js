import { beforeEach, describe, expect, it } from 'vitest'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'

describe('behavior runtime alignment', () => {
	beforeEach(() => {
		runtime.instances = {}
		runtime.pageStates.clear()
	})

	it('injects and transports wx://form-field properties', () => {
		const componentModule = new ComponentModule({
			behaviors: ['wx://form-field'],
			properties: {
				// Component declarations keep higher priority than the behavior.
				value: { type: String, value: 'own' },
			},
	}, {
			component: true,
			path: 'components/form-field/index',
			usingComponents: {},
		})
		const props = componentModule.getProps()

		expect(props.name.type).toEqual(['s'])
		expect(props.value).toMatchObject({ type: ['s'], default: 'own' })
		expect(props.__diminaMeta.builtinBehaviors).toContain('wx://form-field')
	})

	it('runs page behavior lifetimes and observers', async () => {
		const calls = []
		const pageModule = new PageModule({
			behaviors: [{
				created() {
					calls.push('behavior:created')
				},
				attached() {
					calls.push('behavior:attached')
				},
				ready() {
					calls.push('behavior:ready')
				},
				detached() {
					calls.push('behavior:detached')
				},
				pageLifetimes: {
					show() {
						calls.push('behavior:show')
					},
					hide() {
						calls.push('behavior:hide')
					},
					resize(size) {
						calls.push(`behavior:resize:${size?.width}`)
					},
				},
				observers: {
					count(value) {
						calls.push(`behavior:observer:${value}`)
					},
				},
			}],
			data: {
				count: 0,
			},
			created() {
				calls.push('page:created')
			},
			attached() {
				calls.push('page:attached')
			},
			ready() {
				calls.push('page:ready')
			},
			detached() {
				calls.push('page:detached')
			},
			onLoad() {
				calls.push('page:onLoad')
			},
			onShow() {
				calls.push('page:onShow')
			},
			onHide() {
				calls.push('page:onHide')
			},
			onReady() {
				calls.push('page:onReady')
			},
			onUnload() {
				calls.push('page:onUnload')
			},
			onResize(size) {
				calls.push(`page:onResize:${size?.width}`)
			},
			observers: {
				count(value) {
					calls.push(`page:observer:${value}`)
				},
			},
		}, {
			path: 'pages/demo/index',
			usingComponents: {},
		})

		const page = new Page(pageModule, {
			bridgeId: 'bridge-1',
			moduleId: 'page-1',
			path: 'pages/demo/index',
			query: {},
		})

		await page.init()

		page.setData({ count: 1 })
		page.pageShow()
		page.pageHide()
		page.pageResize({ width: 320 })
		page.pageReady()
		page.pageUnload()
		page.pageDetached()

		expect(calls).toEqual([
			'behavior:created',
			'page:created',
			'behavior:attached',
			'page:attached',
			'page:onLoad',
			'behavior:observer:1',
			'page:observer:1',
			'behavior:show',
			'page:onShow',
			'behavior:hide',
			'page:onHide',
			'behavior:resize:320',
			'page:onResize:320',
			'behavior:ready',
			'page:ready',
			'page:onReady',
			'page:onUnload',
			'behavior:detached',
			'page:detached',
		])
	})

	it('runs Component page lifetimes, page callbacks and root teardown in WeChat order', () => {
		const calls = []
		const bridgeId = 'bridge-component-page'
		const componentModule = new ComponentModule({
			behaviors: [{
				lifetimes: {
					created: () => calls.push('behavior:created'),
					attached: () => calls.push('behavior:attached'),
					ready: () => calls.push('behavior:ready'),
					detached: () => calls.push('behavior:detached'),
				},
				pageLifetimes: {
					show: () => calls.push('behavior:show'),
					hide: () => calls.push('behavior:hide'),
				},
			}],
			lifetimes: {
				created: () => calls.push('component-page:created'),
				attached: () => calls.push('component-page:attached'),
				ready: () => calls.push('component-page:ready'),
				detached: () => calls.push('component-page:detached'),
			},
			pageLifetimes: {
				show: () => calls.push('component-page:show'),
				hide: () => calls.push('component-page:hide'),
			},
			methods: {
				onLoad: () => calls.push('component-page:onLoad'),
				onShow: () => calls.push('component-page:onShow'),
				onReady: () => calls.push('component-page:onReady'),
				onHide: () => calls.push('component-page:onHide'),
				onUnload: () => calls.push('component-page:onUnload'),
			},
		}, {
			component: false,
			path: 'pages/component-page/index',
			usingComponents: {},
		})
		const page = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-page',
			path: 'pages/component-page/index',
			query: {},
			eventAttr: {},
			properties: {},
		})

		page.init({ deferPageLoad: true })
		const child = {
			__id__: 'component-page-child',
			__parentId__: page.__id__,
			__type__: ComponentModule.type,
			__isComponent__: true,
			__componentAttached__: true,
			__componentReadied__: true,
			initd: true,
			pageShow() {},
			pageHide() {},
			componentDetached: () => calls.push('child:detached'),
		}
		runtime.instances[bridgeId] = {
			[page.__id__]: page,
			[child.__id__]: child,
		}
		runtime.pageShow({ bridgeId })
		expect(calls).toEqual([
			'behavior:created',
			'component-page:created',
			'behavior:attached',
			'component-page:attached',
		])
		runtime.pageAttached({ bridgeId, moduleId: page.__id__ })
		runtime.pageReady({ bridgeId, moduleId: page.__id__ })
		runtime.pageHide({ bridgeId })
		runtime.pageUnload({ bridgeId })

		expect(calls).toEqual([
			'behavior:created',
			'component-page:created',
			'behavior:attached',
			'component-page:attached',
			'component-page:onLoad',
			'behavior:show',
			'component-page:show',
			'component-page:onShow',
			'behavior:ready',
			'component-page:ready',
			'component-page:onReady',
			'behavior:hide',
			'component-page:hide',
			'component-page:onHide',
			'component-page:onUnload',
			'child:detached',
			'behavior:detached',
			'component-page:detached',
		])
	})

	it('lets a defined lifetimes entry suppress its legacy top-level alias', () => {
		const calls = []
		const componentModule = new ComponentModule({
			behaviors: [{
				created: () => calls.push('behavior:legacy-created'),
				lifetimes: { created: null },
			}],
			created: () => calls.push('component:legacy-created'),
			lifetimes: { created: null },
			methods: {},
		}, {
			component: true,
			path: 'components/lifetime-precedence/index',
			usingComponents: {},
		})
		const component = new Component(componentModule, {
			bridgeId: 'bridge-lifetime-precedence',
			moduleId: 'component-1',
			path: 'components/lifetime-precedence/index',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
		})

		component.init()
		expect(calls).toEqual([])
	})

	it('runs component behavior page lifetimes before component page lifetimes', async () => {
		const calls = []
		const componentModule = new ComponentModule({
			behaviors: [{
				pageLifetimes: {
					show() {
						calls.push('behavior:show')
					},
					hide() {
						calls.push('behavior:hide')
					},
					resize(size) {
						calls.push(`behavior:resize:${size?.width}`)
					},
					routeDone() {
						calls.push('behavior:routeDone')
					},
				},
			}],
			pageLifetimes: {
				show() {
					calls.push('component:show')
				},
				hide() {
					calls.push('component:hide')
				},
				resize(size) {
					calls.push(`component:resize:${size?.width}`)
				},
				routeDone() {
					calls.push('component:routeDone')
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/demo/index',
			usingComponents: {},
		})

		const component = new Component(componentModule, {
			bridgeId: 'bridge-1',
			moduleId: 'component-1',
			path: 'components/demo/index',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
		})

		await component.init()
		component.pageShow()
		component.pageHide()
		component.pageResize({ width: 375 })
		component.componentRouteDone()

		expect(calls).toEqual([
			'behavior:show',
			'component:show',
			'behavior:hide',
			'component:hide',
			'behavior:resize:375',
			'component:resize:375',
			'behavior:routeDone',
			'component:routeDone',
		])
	})

	it('dispatches resize and routeDone to runtime page and component instances', async () => {
		const calls = []
		const bridgeId = 'bridge-runtime'

		const pageModule = new PageModule({
			onResize(size) {
				calls.push(`page:resize:${size?.width}`)
			},
		}, {
			path: 'pages/demo/index',
			usingComponents: {},
		})
		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/demo/index',
			query: {},
		})

		const componentModule = new ComponentModule({
			pageLifetimes: {
				resize(size) {
					calls.push(`component:resize:${size?.width}`)
				},
				routeDone() {
					calls.push('component:routeDone')
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'components/demo/index',
			usingComponents: {},
		})
		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/demo/index',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
		})

		await page.init()
		await component.init()

		runtime.instances = {
			[bridgeId]: {
				'page-1': page,
				'component-1': component,
			},
		}
		await runtime.moduleAttached({ bridgeId, moduleId: component.__id__ })

		runtime.pageResize({ bridgeId, size: { width: 414 } })
		runtime.componentRouteDone({ bridgeId })

		expect(calls).toEqual([
			'component:resize:414',
			'page:resize:414',
			'component:routeDone',
		])
	})
})
