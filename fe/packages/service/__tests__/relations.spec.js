import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import runtime from '../src/core/runtime'

describe('组件间关系测试', () => {
	beforeEach(() => {
		// 清理运行时实例
		runtime.instances = {}
	})

	test('parent-child 关系建立', async () => {
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

		// 初始化组件以建立关系
		await Promise.all([parentComponent.init(), childComponent.init()])
		await runtime.moduleAttached({ bridgeId, moduleId: parentComponent.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: childComponent.__id__ })

		// 验证父组件获取子组件
		const childNodes = parentComponent.getRelationNodes('./child-component')
		expect(childNodes).toHaveLength(1)
		expect(childNodes[0]).toBe(childComponent)
		expect(parentComponent.linkedChild).toBe(childComponent)
		expect(parentComponent.getRelationNodes('./undeclared-component')).toBeNull()
		expect(parentComponent.getRelationNodes()).toBeNull()

		// 验证子组件获取父组件
		const parentNodes = childComponent.getRelationNodes('./parent-component')
		expect(parentNodes).toHaveLength(1)
		expect(parentNodes[0]).toBe(parentComponent)
		expect(childComponent.linkedParent).toBe(parentComponent)
	})

	test('ancestor-descendant 关系建立', async () => {
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

		// 初始化组件以建立关系
		await Promise.all([ancestorComponent.init(), middleComponent.init(), descendantComponent.init()])
		await runtime.moduleAttached({ bridgeId, moduleId: ancestorComponent.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: middleComponent.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: descendantComponent.__id__ })

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
	})

	test('多个同类祖先只连接各自渲染树中的后代', async () => {
		const bridgeId = 'test-bridge-isolated-relations'
		const parentModule = new ComponentModule({
			lifetimes: {
				created() {
					this.children = []
				},
			},
			relations: {
				'./tab-panel': {
					type: 'descendant',
					linked(target) {
						this.children.push(target)
					},
				},
			},
			methods: {},
		}, {
			component: true,
			path: 'tabs',
			usingComponents: {},
		})
		const childModule = new ComponentModule({
			relations: {
				'./tabs': { type: 'ancestor' },
			},
			methods: {},
		}, {
			component: true,
			path: 'tab-panel',
			usingComponents: {},
		})
		const create = (module, moduleId, path) => new Component(module, {
			bridgeId,
			moduleId,
			path,
			pageId: 'page-1',
			parentId: 'page-1',
			eventAttr: {},
			properties: {},
			targetInfo: {},
		})
		const parent1 = create(parentModule, 'tabs-1', 'tabs')
		const parent2 = create(parentModule, 'tabs-2', 'tabs')
		const child1 = create(childModule, 'panel-1', 'tab-panel')
		const child2 = create(childModule, 'panel-2', 'tab-panel')
		runtime.instances[bridgeId] = {
			[parent1.__id__]: parent1,
			[parent2.__id__]: parent2,
			[child1.__id__]: child1,
			[child2.__id__]: child2,
		}
		for (const instance of [parent1, parent2, child1, child2]) instance.init()
		await runtime.moduleAttached({ bridgeId, moduleId: parent1.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: parent2.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: child1.__id__, parentId: parent1.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: child2.__id__, parentId: parent2.__id__ })

		expect(parent1.children).toEqual([child1])
		expect(parent2.children).toEqual([child2])
	})

	test('组件 detached 时移除关系', async () => {
		const bridgeId = 'test-bridge-3'
		const detachCalls = []
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
						detachCalls.push('relation:unlinked')
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
			lifetimes: {
				detached() {
					detachCalls.push(`detached:relations=${runtime.instances[bridgeId]['parent-1'].getRelationNodes('./child-component').length}`)
				},
			},
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

		// 初始化组件以建立关系
		await Promise.all([parentComponent.init(), childComponent.init()])
		await runtime.moduleAttached({ bridgeId, moduleId: parentComponent.__id__ })
		await runtime.moduleAttached({ bridgeId, moduleId: childComponent.__id__ })

		// 验证关系已建立
		expect(parentComponent.getRelationNodes('./child-component')).toHaveLength(1)
		expect(parentComponent.linkedChildren).toContain(childComponent)

		// 模拟子组件被移除
		childComponent.componentDetached()

		// 验证关系已移除（同步）
		expect(parentComponent.getRelationNodes('./child-component')).toHaveLength(0)
		expect(parentComponent.unlinkedChildren).toContain(childComponent)
		expect(detachCalls).toEqual(['detached:relations=1', 'relation:unlinked'])
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
		
		// 初始化组件以触发关系路径解析
		parentComponent.init()

		// 验证路径解析 - 通过公共方法间接验证
		// 由于 __relationPaths__ 是私有属性，我们通过其他方式验证路径解析是否正确
		expect(parentComponent.__relationPaths__.get('../sibling/child-component')).toBe('components/sibling/child-component')
	})

	test('双向关系建立 - 父组件先创建', async () => {
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

		// 初始化父组件
		await parentComponent.init()
		await runtime.moduleAttached({ bridgeId, moduleId: parentComponent.__id__ })

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

		await childComponent.init()
		await runtime.moduleAttached({ bridgeId, moduleId: childComponent.__id__ })

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
	})
})
