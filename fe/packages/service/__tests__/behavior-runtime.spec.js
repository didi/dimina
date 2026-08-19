import { beforeEach, describe, expect, it, vi } from 'vitest'
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
		let pageResizeRes
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
					resize(res) {
						calls.push(`behavior:resize:${res?.size?.windowWidth}`)
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
			onResize(res) {
				calls.push(`page:onResize:${res?.size?.windowWidth}`)
				pageResizeRes = res
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
		page.pageResize({ size: { windowWidth: 320, windowHeight: 640 }, deviceOrientation: 'portrait' })
		page.pageReady()
		page.pageUnload()

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
			'behavior:detached',
			'page:detached',
			'page:onUnload',
		])

		expect(pageResizeRes.size.windowWidth).toBe(320)
		expect(pageResizeRes.deviceOrientation).toBe('portrait')
	})

	it('runs component behavior page lifetimes before component page lifetimes', async () => {
		const calls = []
		let componentResizeRes
		const componentModule = new ComponentModule({
			behaviors: [{
				pageLifetimes: {
					show() {
						calls.push('behavior:show')
					},
					hide() {
						calls.push('behavior:hide')
					},
					resize(res) {
						calls.push(`behavior:resize:${res?.size?.windowWidth}`)
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
				resize(res) {
					calls.push(`component:resize:${res?.size?.windowWidth}`)
					componentResizeRes = res
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
		component.pageResize({ size: { windowWidth: 375, windowHeight: 667 }, deviceOrientation: 'portrait' })
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

		expect(componentResizeRes.size.windowWidth).toBe(375)
		expect(componentResizeRes.deviceOrientation).toBe('portrait')
	})

	it('dispatches resize and routeDone to runtime page and component instances', async () => {
		const calls = []
		const bridgeId = 'bridge-runtime'
		let pageResizeRes
		let componentResizeRes

		const pageModule = new PageModule({
			onResize(res) {
				calls.push(`page:resize:${res?.size?.windowWidth}`)
				pageResizeRes = res
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
				resize(res) {
					calls.push(`component:resize:${res?.size?.windowWidth}`)
					componentResizeRes = res
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
		runtime.pageShow({ bridgeId })

		// pageResize 结算走 16ms 合并窗口，两次上报之间推进定时器让它们分别结算。
		vi.useFakeTimers()

		// deviceOrientation 缺失时按屏幕宽高比兜底：宽 > 高判定为 landscape。
		runtime.pageResize({ bridgeId, size: { windowWidth: 800, windowHeight: 400 } })
		vi.advanceTimersByTime(16)
		expect(pageResizeRes.size.windowWidth).toBe(800)
		expect(pageResizeRes.deviceOrientation).toBe('landscape')
		expect(componentResizeRes.size.windowWidth).toBe(800)
		expect(componentResizeRes.deviceOrientation).toBe('landscape')

		// 宽 <= 高判定为 portrait。
		runtime.pageResize({ bridgeId, size: { windowWidth: 400, windowHeight: 800 } })
		vi.advanceTimersByTime(16)
		expect(pageResizeRes.deviceOrientation).toBe('portrait')
		expect(componentResizeRes.deviceOrientation).toBe('portrait')

		vi.useRealTimers()

		runtime.componentRouteDone({ bridgeId })

		expect(calls).toEqual([
			'component:resize:800',
			'page:resize:800',
			'component:resize:400',
			'page:resize:400',
			'component:routeDone',
		])
	})
})
