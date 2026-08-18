import { cloneDeep, isFunction } from '@dimina/common'
import { createSelectorQuery } from '../../api/core/wxml/selector-query'
import message from '../../core/message'
import runtime from '../../core/runtime'
import { applyDataUpdates } from '../../core/data-update'
import { invokeSafely, invokeSafelyAll } from '../../core/safe-callback'
import { createUpdateCallback, enqueueUpdate } from '../../core/update-queue'
import { isChildComponent, matchComponent, syncUpdateChildrenProps } from '../../core/utils'

// https://developers.weixin.qq.com/miniprogram/dev/reference/api/Page.html
// const lifecycleMethods = ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload',
//     'onPullDownRefresh', 'onReachBottom', 'onShareAppMessage', 'onPageScroll',
//     'onResize', 'onTabItemTap'
// ];

export class Page {
	constructor(module, opts) {
		this.initd = false
		this.opts = opts
		this.is = opts.path
		this.route = opts.path
		this.bridgeId = opts.bridgeId
		this.id = opts.bridgeId
		this.query = opts.query
		this.data = cloneDeep(module.noReferenceData)
		this.__type__ = module.type
		this.__id__ = opts.moduleId
		this.__info__ = module.moduleInfo
		
		// 保存子组件 properties 绑定关系（用于同步更新）
		// 格式：{ childModuleId: { childPropName: parentDataKey } }
		this.__childPropsBindings__ = {}
		this.__pendingInitSetDataCallbacks__ = []
	}

	init({ deferInitialData = false } = {}) {
		this.#initMembers()
		this.#invokeInitLifecycle()
		if (!deferInitialData) {
			this.sendInitialData()
		}
	}

	sendInitialData() {
		if (this.__initialDataSent__) {
			return
		}
		this.__initialDataSent__ = true
		message.send({
			type: this.__id__,
			target: 'render',
			body: {
				bridgeId: this.bridgeId,
				path: this.is,
				data: this.data,
			},
		})
	}

	flushInitSetDataCallbacks() {
		if (this.__pendingInitSetDataCallbacks__.length === 0) {
			return
		}

		const callbacks = this.__pendingInitSetDataCallbacks__
		this.__pendingInitSetDataCallbacks__ = []
		enqueueUpdate(this.bridgeId, this.__id__, {}, createUpdateCallback(this, callbacks))
	}

	setData(data, callback) {
		const update = applyDataUpdates(this, data, callback)
		if (!update) {
			return
		}

		if (!this.initd) {
			this.__pendingInitSetDataCallbacks__.push(...update.callbacks)
			return
		}

		// 同步更新子组件的 properties，确保与微信小程序时序一致
		const syncedChildren = syncUpdateChildrenProps(this, runtime.instances[this.bridgeId], update.changedData)

		enqueueUpdate(
			this.bridgeId,
			this.__id__,
			update.changedData,
			createUpdateCallback(this, update.callbacks),
			update.changes,
		)

		syncedChildren.forEach(({ child, data }) => {
			enqueueUpdate(this.bridgeId, child.__id__, data)
		})
	}

	/**
	 * 创建一个 SelectorQuery 对象，选择器选取范围为这个页面实例内
	 */
	createSelectorQuery() {
		return createSelectorQuery().in(this)
	}

	/**
	 * 返回当前 tab 页直属的自定义 tabBar 组件实例。
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/ability/custom-tabbar.html
	 */
	getTabBar() {
		const instances = Object.values(runtime.instances[this.bridgeId] || {})
		return instances.find(item =>
			item?.__isComponent__
			&& item.__isCustomTabBar__
			&& isChildComponent(item, this.__id__, instances),
		) || null
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/events.html#获取组件实例
	 * 使用选择器选取页面中的组件实例对象，返回匹配到的第一个组件实例对象
	 */
	selectComponent(selector) {
		const children = Object.values(runtime.instances[this.bridgeId] || {})

		// 遍历所有组件查找匹配的子组件
		const matchedComponent = children.find(item =>
			isChildComponent(item, this.__id__, children) && matchComponent(selector, item),
		)

		if (!matchedComponent) {
			return null
		}

		// 检查组件是否使用了 wx://component-export behavior
		if (matchedComponent.hasBehavior && matchedComponent.hasBehavior('wx://component-export') && matchedComponent.export) {
			// 如果组件定义了 export 方法，返回自定义的导出结果
			return matchedComponent.export()
		}

		// 默认返回组件实例本身
		return matchedComponent
	}

	/**
	 * 使用选择器选取页面中的组件实例对象，返回匹配到的全部组件实例对象组成的数组
	 */
	selectAllComponents(selector) {
		const children = Object.values(runtime.instances[this.bridgeId] || {})

		// 遍历所有组件查找匹配的子组件
		const matchedComponents = children.filter(item =>
			isChildComponent(item, this.__id__, children) && matchComponent(selector, item),
		)

		// 处理每个匹配的组件，检查是否有自定义导出
		return matchedComponents.map(component => {
			if (component.hasBehavior && component.hasBehavior('wx://component-export') && component.export) {
				return component.export()
			}
			return component
		})
	}

	// 开发者自定义函数
	#initMembers() {
		for (const attr in this.__info__) {
			const member = this.__info__[attr]
			if (isFunction(member)) {
				this[attr] = member.bind(this)
			}
			else {
				this[attr] = member
			}
		}
	}

	#invokeInitLifecycle() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.created, [], 'created lifetime')
		invokeSafely(this, this.created, [], 'created lifetime')
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.attached, [], 'attached lifetime')
		invokeSafely(this, this.attached, [], 'attached lifetime')

		// 页面创建时执行
		invokeSafely(this, this.onLoad, [this.opts.query || {}], 'onLoad')
		this.initd = true
	}

	/**
	 * 页面显示/切入前台时触发。该时机不能保证页面渲染完成，如有页面/组件元素相关操作建议在 onReady 中处理
	 */
	pageShow() {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.show, [], 'page show lifetime')
		invokeSafely(this, this.onShow, [], 'onShow')
	}

	pageHide() {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.hide, [], 'page hide lifetime')
		invokeSafely(this, this.onHide, [], 'onHide')
	}

	pageReady() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.ready, [], 'ready lifetime')
		invokeSafely(this, this.ready, [], 'ready lifetime')
		invokeSafely(this, this.onReady, [], 'onReady')
	}

	pageUnload() {
		invokeSafelyAll(this, this.__info__.behaviorLifetimes?.detached, [], 'detached lifetime')
		invokeSafely(this, this.detached, [], 'detached lifetime')
		invokeSafely(this, this.onUnload, [], 'onUnload')
		this.initd = false
	}

	pageScrollTop(opts) {
		const { scrollTop } = opts
		invokeSafely(this, this.onPageScroll, [{ scrollTop }], 'onPageScroll')
	}

	pagePullDownRefresh() {
		invokeSafely(this, this.onPullDownRefresh, [], 'onPullDownRefresh')
	}

	pageReachBottom() {
		invokeSafely(this, this.onReachBottom, [], 'onReachBottom')
	}

	pageShareAppMessage(options = {}) {
		return invokeSafely(this, this.onShareAppMessage, [options], 'onShareAppMessage')
	}

	pageTabItemTap(item = {}) {
		invokeSafely(this, this.onTabItemTap, [item], 'onTabItemTap')
	}

	pageResize(size) {
		invokeSafelyAll(this, this.__info__.behaviorPageLifetimes?.resize, [size], 'page resize lifetime')
		invokeSafely(this, this.onResize, [size], 'onResize')
	}
}
