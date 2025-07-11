import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

describe('Page selectComponent 测试', () => {
	beforeEach(() => {
		// 清理运行时实例
		runtime.instances = {}
	})

	test('页面使用 ID 选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		// 创建组件
		const componentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'components/my-component',
			usingComponents: {}
		})

		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/my-component',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				id: 'my-component'
			}
		})

		runtime.instances[bridgeId]['page-1'] = page
		runtime.instances[bridgeId]['component-1'] = component

		// 测试页面选择组件
		const selectedComponent = page.selectComponent('#my-component')
		expect(selectedComponent).toBe(component)
	})

	test('页面使用类选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		// 创建组件
		const componentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'components/my-component',
			usingComponents: {}
		})

		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/my-component',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				class: 'my-class'
			}
		})

		runtime.instances[bridgeId]['page-1'] = page
		runtime.instances[bridgeId]['component-1'] = component

		// 测试页面选择组件
		const selectedComponent = page.selectComponent('.my-class')
		expect(selectedComponent).toBe(component)
	})

	test('页面使用 selectAllComponents 选择多个组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		// 创建多个组件
		const componentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'components/my-component',
			usingComponents: {}
		})

		const component1 = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/my-component',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				class: 'my-class'
			}
		})

		const component2 = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-2',
			path: 'components/my-component',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				class: 'my-class'
			}
		})

		runtime.instances[bridgeId]['page-1'] = page
		runtime.instances[bridgeId]['component-1'] = component1
		runtime.instances[bridgeId]['component-2'] = component2

		// 测试页面选择多个组件
		const selectedComponents = page.selectAllComponents('.my-class')
		expect(selectedComponents).toHaveLength(2)
		expect(selectedComponents).toContain(component1)
		expect(selectedComponents).toContain(component2)
	})

	test('页面选择带有 wx://component-export behavior 的组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		// 创建带有 wx://component-export behavior 的组件
		const componentModule = new ComponentModule({
			behaviors: ['wx://component-export'],
			export() {
				return { myField: 'myValue' }
			},
			methods: {}
		}, {
			component: true,
			path: 'components/my-component',
			usingComponents: {}
		})

		const component = new Component(componentModule, {
			bridgeId,
			moduleId: 'component-1',
			path: 'components/my-component',
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				id: 'export-component'
			}
		})

		runtime.instances[bridgeId]['page-1'] = page
		runtime.instances[bridgeId]['component-1'] = component

		// 测试页面选择组件并返回自定义导出
		const result = page.selectComponent('#export-component')
		expect(result).toEqual({ myField: 'myValue' })
	})

	test('页面选择器未匹配时返回 null', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		runtime.instances[bridgeId]['page-1'] = page

		// 测试未匹配的选择器
		const result = page.selectComponent('#non-existent')
		expect(result).toBeNull()
	})

	test('页面可以创建 SelectorQuery', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建页面
		const pageModule = new PageModule({
			onLoad() {
				console.log('页面加载')
			}
		}, {
			path: 'pages/index/index'
		})

		const page = new Page(pageModule, {
			bridgeId,
			moduleId: 'page-1',
			path: 'pages/index/index',
			query: {}
		})

		runtime.instances[bridgeId]['page-1'] = page

		// 测试创建 SelectorQuery
		const selectorQuery = page.createSelectorQuery()
		expect(selectorQuery).toBeDefined()
		expect(selectorQuery.select).toBeDefined()
		expect(selectorQuery.selectAll).toBeDefined()
	})
}) 