import { beforeEach, describe, expect, it } from 'vitest'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'

describe('behavior runtime alignment', () => {
	beforeEach(() => {
		runtime.instances = {}
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
					count(value, oldValue) {
						calls.push(`behavior:observer:${oldValue ?? 'undefined'}->${value}`)
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
				count(value, oldValue) {
					calls.push(`page:observer:${oldValue}->${value}`)
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

		expect(calls).toEqual([
			'behavior:created',
			'page:created',
			'behavior:attached',
			'page:attached',
			'page:onLoad',
			'page:observer:0->1',
			'behavior:observer:0->1',
			'behavior:show',
			'page:onShow',
			'behavior:hide',
			'page:onHide',
			'behavior:resize:320',
			'page:onResize:320',
			'behavior:ready',
			'page:ready',
			'page:onReady',
			'behavior:detached',
			'page:detached',
			'page:onUnload',
		])
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

		runtime.pageResize({ bridgeId, size: { width: 414 } })
		runtime.componentRouteDone({ bridgeId })

		expect(calls).toEqual([
			'page:resize:414',
			'component:resize:414',
			'component:routeDone',
		])
	})
})
