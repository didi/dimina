import { cloneDeep, isFunction, set } from '@dimina/common'
import { createSelectorQuery } from '../../api/core/wxml/selector-query'
import message from '../../core/message'
import runtime from '../../core/runtime'
import { addComputedData, filterData, isChildComponent, matchComponent } from '../../core/utils'

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
		this.bridgeId = opts.bridgeId
		this.data = cloneDeep(module.noReferenceData)
		this.__type__ = module.type
		this.__id__ = opts.moduleId
		this.__info__ = module.moduleInfo

		this.#init()
	}

	#init() {
		this.#initMembers()
		this.#invokeInitLifecycle().then(() => {
			addComputedData(this)
			message.send({
				type: this.__id__,
				target: 'render',
				body: {
					bridgeId: this.bridgeId,
					path: this.is,
					data: this.data,
				},
			})
		})
	}

	setData(data) {
		const fData = filterData(data)
		for (const key in fData) {
			set(this.data, key, fData[key])
		}

		if (!this.initd) {
			return
		}

		message.send({
			type: 'u',
			target: 'render',
			body: {
				bridgeId: this.bridgeId,
				moduleId: this.__id__,
				data: fData,
			},
		})
	}

	/**
	 * 创建一个 SelectorQuery 对象，选择器选取范围为这个页面实例内
	 */
	createSelectorQuery() {
		return createSelectorQuery().in(this)
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

	async #invokeInitLifecycle() {
		// 页面创建时执行
		await this.onLoad?.(this.opts.query || {})
		this.initd = true
	}

	/**
	 * 页面显示/切入前台时触发。该时机不能保证页面渲染完成，如有页面/组件元素相关操作建议在 onReady 中处理
	 */
	pageShow() {
		this.onShow?.()
	}

	pageHide() {
		this.onHide?.()
	}

	pageReady() {
		this.onReady?.()
	}

	pageUnload() {
		this.onUnload?.()
		this.initd = false
	}

	pageScrollTop(opts) {
		const { scrollTop } = opts
		this.onPageScroll?.({ scrollTop })
	}
}
