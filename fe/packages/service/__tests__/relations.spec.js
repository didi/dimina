import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

describe('组件间关系测试', () => {
	beforeEach(() => {
		// 清理运行时实例
		runtime.instances = {}
	})

	test('parent-child 关系建立', (done) => {
		const bridgeId = 'test-bridge'
		runtime.instances[bridgeId] = {}

		// 创建父组件模块
		const parentModule = new ComponentModule({
			relations: {
				'./child-component': {
					type: 'child',
					linked: function(target) {
						this.linkedChild = target
					},
					unlinked: function(target) {
						this.unlinkedChild = target
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		// 创建子组件模块
		const childModule = new ComponentModule({
			relations: {
				'./parent-component': {
					type: 'parent',
					linked: function(target) {
						this.linkedParent = target
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		// 创建父组件实例
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

		// 创建子组件实例
		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 等待关系建立
		setTimeout(() => {
			// 验证父组件获取子组件
			const childNodes = parentComponent.getRelationNodes('./child-component')
			expect(childNodes).toHaveLength(1)
			expect(childNodes[0]).toBe(childComponent)
			expect(parentComponent.linkedChild).toBe(childComponent)

			// 验证子组件获取父组件
			const parentNodes = childComponent.getRelationNodes('./parent-component')
			expect(parentNodes).toHaveLength(1)
			expect(parentNodes[0]).toBe(parentComponent)
			expect(childComponent.linkedParent).toBe(parentComponent)

			done()
		}, 10)
	})

	test('ancestor-descendant 关系建立', (done) => {
		const bridgeId = 'test-bridge-2'
		runtime.instances[bridgeId] = {}

		// 创建祖先组件模块
		const ancestorModule = new ComponentModule({
			relations: {
				'./descendant-component': {
					type: 'descendant',
					linked: function(target) {
						this.descendants = this.descendants || []
						this.descendants.push(target)
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'ancestor-component',
			usingComponents: {}
		})

		// 创建中间组件模块
		const middleModule = new ComponentModule({
			methods: {}
		}, {
			component: true,
			path: 'middle-component',
			usingComponents: {}
		})

		// 创建后代组件模块
		const descendantModule = new ComponentModule({
			relations: {
				'./ancestor-component': {
					type: 'ancestor',
					linked: function(target) {
						this.ancestor = target
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'descendant-component',
			usingComponents: {}
		})

		// 创建组件实例
		const ancestorComponent = new Component(ancestorModule, {
			bridgeId,
			moduleId: 'ancestor-1',
			path: 'ancestor-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		const middleComponent = new Component(middleModule, {
			bridgeId,
			moduleId: 'middle-1',
			path: 'middle-component',
			pageId: 'page-1',
			parentId: 'ancestor-1',
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		const descendantComponent = new Component(descendantModule, {
			bridgeId,
			moduleId: 'descendant-1',
			path: 'descendant-component',
			pageId: 'page-1',
			parentId: 'middle-1',
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		runtime.instances[bridgeId]['ancestor-1'] = ancestorComponent
		runtime.instances[bridgeId]['middle-1'] = middleComponent
		runtime.instances[bridgeId]['descendant-1'] = descendantComponent

		// 等待关系建立
		setTimeout(() => {
			// 验证祖先组件获取后代组件
			const descendantNodes = ancestorComponent.getRelationNodes('./descendant-component')
			expect(descendantNodes).toHaveLength(1)
			expect(descendantNodes[0]).toBe(descendantComponent)
			expect(ancestorComponent.descendants).toContain(descendantComponent)

			// 验证后代组件获取祖先组件
			const ancestorNodes = descendantComponent.getRelationNodes('./ancestor-component')
			expect(ancestorNodes).toHaveLength(1)
			expect(ancestorNodes[0]).toBe(ancestorComponent)
			expect(descendantComponent.ancestor).toBe(ancestorComponent)

			done()
		}, 10)
	})

	test('组件 detached 时移除关系', (done) => {
		const bridgeId = 'test-bridge-3'
		runtime.instances[bridgeId] = {}

		// 创建父组件模块
		const parentModule = new ComponentModule({
			relations: {
				'./child-component': {
					type: 'child',
					linked: function(target) {
						this.linkedChildren = this.linkedChildren || []
						this.linkedChildren.push(target)
					},
					unlinked: function(target) {
						this.unlinkedChildren = this.unlinkedChildren || []
						this.unlinkedChildren.push(target)
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		// 创建子组件模块
		const childModule = new ComponentModule({
			relations: {
				'./parent-component': {
					type: 'parent'
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		// 创建组件实例
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

		const childComponent = new Component(childModule, {
			bridgeId,
			moduleId: 'child-1',
			path: 'child-component',
			pageId: 'page-1',
			parentId: 'parent-1',
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		runtime.instances[bridgeId]['parent-1'] = parentComponent
		runtime.instances[bridgeId]['child-1'] = childComponent

		// 等待关系建立
		setTimeout(() => {
			// 验证关系已建立
			expect(parentComponent.getRelationNodes('./child-component')).toHaveLength(1)
			expect(parentComponent.linkedChildren).toContain(childComponent)

			// 模拟子组件被移除
			childComponent.componentDetached()

			// 验证关系已移除
			expect(parentComponent.getRelationNodes('./child-component')).toHaveLength(0)
			expect(parentComponent.unlinkedChildren).toContain(childComponent)

			done()
		}, 10)
	})

	test('相对路径解析', () => {
		const bridgeId = 'test-bridge-4'
		runtime.instances[bridgeId] = {}

		const parentModule = new ComponentModule({
			relations: {
				'../sibling/child-component': {
					type: 'child'
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'components/parent/parent-component',
			usingComponents: {}
		})

		const parentComponent = new Component(parentModule, {
			bridgeId,
			moduleId: 'parent-1',
			path: 'components/parent/parent-component',
			pageId: 'page-1',
			parentId: null,
			eventAttr: {},
			properties: {},
			targetInfo: {}
		})

		// 验证路径解析 - 通过公共方法间接验证
		// 由于 __relationPaths__ 是私有属性，我们通过其他方式验证路径解析是否正确
		expect(parentComponent.__relationPaths__.get('../sibling/child-component')).toBe('components/sibling/child-component')
	})

	test('双向关系建立 - 父组件先创建', (done) => {
		const bridgeId = 'test-bridge-5'
		runtime.instances[bridgeId] = {}

		// 创建父组件模块
		const parentModule = new ComponentModule({
			relations: {
				'./child-component': {
					type: 'child',
					linked: function(target) {
						this.linkedChildren = this.linkedChildren || []
						this.linkedChildren.push(target)
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'parent-component',
			usingComponents: {}
		})

		// 创建子组件模块
		const childModule = new ComponentModule({
			relations: {
				'./parent-component': {
					type: 'parent',
					linked: function(target) {
						this.linkedParent = target
					}
				}
			},
			methods: {}
		}, {
			component: true,
			path: 'child-component',
			usingComponents: {}
		})

		// 先创建父组件
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

		// 延迟创建子组件
		setTimeout(() => {
			const childComponent = new Component(childModule, {
				bridgeId,
				moduleId: 'child-1',
				path: 'child-component',
				pageId: 'page-1',
				parentId: 'parent-1',
				eventAttr: {},
				properties: {},
				targetInfo: {}
			})

			runtime.instances[bridgeId]['child-1'] = childComponent

			// 等待关系建立
			setTimeout(() => {
				// 验证父组件能获取子组件（这是关键测试点）
				const childNodes = parentComponent.getRelationNodes('./child-component')
				expect(childNodes).toHaveLength(1)
				expect(childNodes[0]).toBe(childComponent)
				expect(parentComponent.linkedChildren).toContain(childComponent)

				// 验证子组件能获取父组件
				const parentNodes = childComponent.getRelationNodes('./parent-component')
				expect(parentNodes).toHaveLength(1)
				expect(parentNodes[0]).toBe(parentComponent)
				expect(childComponent.linkedParent).toBe(parentComponent)

				done()
			}, 10)
		}, 5)
	})
}) 