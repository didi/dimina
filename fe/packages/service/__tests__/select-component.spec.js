import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

describe('selectComponent 测试', () => {
	beforeEach(() => {
		// 清理运行时实例
		runtime.instances = {}
	})

	test('使用 ID 选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 创建子组件
		const childModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				id: 'my-child'
			}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 测试 ID 选择器
		const selectedComponent = parentComponent.selectComponent('#my-child')
		expect(selectedComponent).toBe(childComponent)
	})

	test('使用类选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 创建子组件
		const childModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				class: 'my-class another-class'
			}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 测试类选择器
		const selectedComponent = parentComponent.selectComponent('.my-class')
		expect(selectedComponent).toBe(childComponent)
	})

	test('使用标签选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 创建子组件
		const childModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'components/child-component',
			usingComponents: {}
		})

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'components/child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 测试标签选择器
		const selectedComponent = parentComponent.selectComponent('child-component')
		expect(selectedComponent).toBe(childComponent)
	})

	test('使用 wx://component-export behavior 自定义返回值', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 创建带有 wx://component-export behavior 的子组件
		const childModule = new ComponentModule({
			behaviors: ['wx://component-export'],
			export() {
				return { myField: 'myValue' }
			},
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				id: 'the-id'
			}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 测试自定义导出
		const result = parentComponent.selectComponent('#the-id')
		expect(result).toEqual({ myField: 'myValue' })
	})

	test('选择器未匹配时返回 null', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent

		// 测试未匹配的选择器
		const result = parentComponent.selectComponent('#non-existent')
		expect(result).toBeNull()
	})

	test('使用属性选择器选择组件', () => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件
		const parentModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 创建子组件
		const childModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {
				dataset: {
					type: 'button',
					name: 'submit'
				}
			}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 测试属性选择器
		const selectedByType = parentComponent.selectComponent('[type=button]')
		expect(selectedByType).toBe(childComponent)

		const selectedByName = parentComponent.selectComponent('[name=submit]')
		expect(selectedByName).toBe(childComponent)

		// 测试只检查属性存在
		const selectedByExistence = parentComponent.selectComponent('[type]')
		expect(selectedByExistence).toBe(childComponent)
	})
}) 