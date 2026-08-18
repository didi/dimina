import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'

/**
 * 创建并返回一个 IntersectionObserver 对象实例。在自定义组件或包含自定义组件的页面中，应使用 this.createIntersectionObserver([options]) 来代替。
 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/wx.createIntersectionObserver.html
 */
export function createIntersectionObserver(component, options = {}) {
	const {
		thresholds = [0], // 设定默认值 [0]
		initialRatio = 0, // 设定默认值 0
		observeAll = false, // 设定默认值 false
	} = options
	return new IntersectionObserver(component, { thresholds, initialRatio, observeAll })
}

class IntersectionObserver {
	constructor(component, options) {
		this._component = component
		this._options = options
		this._relativeInfo = []
		this._observerId = null
		this._disconnected = false
	}

	/**
	 * 使用选择器指定一个节点，作为参照区域之一
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.relativeTo.html
	 */
	relativeTo(selector, margins = { left: 0, right: 0, top: 0, bottom: 0 }) {
		if (this._observerId !== null) {
			throw new Error('Relative nodes cannot be added after "observe" call in IntersectionObserver')
		}
		this._relativeInfo.push({
			selector,
			margins: ['left', 'right', 'top', 'bottom'].map(key => `${margins[key] === undefined ? 0 : margins[key]}px`).join(' '),
		})
		return this
	}

	/**
	 * 指定页面显示区域作为参照区域之一
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.relativeToViewport.html
	 */
	relativeToViewport(margins = { left: 0, right: 0, top: 0, bottom: 0 }) {
		if (this._observerId !== null) {
			throw new Error('Relative nodes cannot be added after "observe" call in IntersectionObserver')
		}

		this._relativeInfo.push({
			selector: null,
			margins: ['left', 'right', 'top', 'bottom'].map(key => `${margins[key] === undefined ? 0 : margins[key]}px`).join(' '),
		})
		return this
	}

	/**
	 * 指定目标节点并开始监听相交状态变化情况
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.observe.html
	 */
	observe(targetSelector, listener) {
		const that = this
		const id = callback.store((res) => {
			if (!that._disconnected) {
				that._observerId = res.observerId
			}
			if (res.info) {
				listener.call(that, res.info)
			}
		}, true)

		invokeAPI('addIntersectionObserver', {
			moduleId: this._component.__id__,
			targetSelector,
			relativeInfo: this._relativeInfo,
			options: this._options,
			success: id,
		}, 'render')
	}

	/**
	 * 停止监听。回调函数将不再触发
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.disconnect.html
	 */
	disconnect() {
		invokeAPI('removeIntersectionObserver', {
			observerId: this._observerId,
		}, 'render')
		this._disconnected = true
	}
}
