import { isFunction } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import router from '@/core/router'
import { hydrateSelectorQueryResult } from '../../ui/canvas/canvas-node'

/**
 * 返回一个 SelectorQuery 对象实例。在自定义组件或包含自定义组件的页面中，应使用 this.createSelectorQuery() 来代替。
 * https://developers.weixin.qq.com/miniprogram/dev/framework/view/selector.html
 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/wx.createSelectorQuery.html
 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/SelectorQuery.html
 */
export function createSelectorQuery() {
	return new SelectorQuery()
}

function getCurrentPageInfo() {
	return router.getPageInfo()
}

function getCurrentModuleId() {
	const pageInfo = getCurrentPageInfo()
	return pageInfo?.__id__ || pageInfo?.id
}

function getCurrentBridgeId() {
	const pageInfo = getCurrentPageInfo()
	return pageInfo?.bridgeId || pageInfo?.id
}

class SelectorQuery {
	constructor() {
		this.__componentId = getCurrentModuleId()
		this.__taskQueue = []
		this.__cbQueue = []
	}

	/**
	 * 将选择器的选取范围更改为自定义组件 component 内。（初始时，选择器仅选取页面范围的节点，不会选取任何自定义组件中的节点）。
	 * @param {Component} com
	 * @returns {SelectorQuery} SelectorQuery
	 */
	in(com) {
		this.__componentId = com.__id__
		return this
	}

	/**
	 * 在当前页面下选择第一个匹配选择器 selector 的节点。返回一个 NodesRef 对象实例，可以用于获取节点信息。
	 * @param {string} selector
	 * @returns {NodesRef} NodesRef
	 */
	select(selector) {
		return new NodesRef(this, this.__componentId, selector, true)
	}

	/**
	 * 在当前页面下选择匹配选择器 selector 的所有节点。
	 * @param {string} selector
	 * @returns {NodesRef} NodesRef
	 */
	selectAll(selector) {
		return new NodesRef(this, this.__componentId, selector, false)
	}

	/**
	 * 选择显示区域。可用于获取显示区域的尺寸、滚动位置等信息。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/SelectorQuery.selectViewport.html
	 * @returns {NodesRef} NodesRef
	 */
	selectViewport() {
		return new NodesRef(this, getCurrentModuleId(), '', true)
	}

	/**
	 *
	 * @param {*} selector
	 * @param {*} moduleId
	 * @param {*} single
	 * @param {*} fields
	 * @param {*} callback
	 */
	__push(selector, moduleId, single, fields, callback) {
		this.__taskQueue.push({
			moduleId,
			selector,
			single,
			fields,
		})
		this.__cbQueue.push(callback)
	}

	/**
	 * 执行所有的请求。请求结果按请求次序构成数组，在callback的第一个参数中返回。
	 * @param {Function} callback
	 */
	exec(callback) {
		const self = this
		const bridgeId = getCurrentBridgeId()
		const data = {
			tasks: this.__taskQueue,
			success: (res) => {
				const hydratedRes = hydrateSelectorQueryResult(res, bridgeId) || []
				hydratedRes.forEach((nodeInfo, index) => {
					const cb = self.__cbQueue[index]
					if (isFunction(cb)) {
						cb.call(self, nodeInfo)
					}
				})

				if (isFunction(callback)) {
					callback.call(self, hydratedRes)
				}
			},
		}
		invokeAPI('selectorQuery', data, 'render')
	}
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.html
 */
class NodesRef {
	constructor(selectorQuery, componentId, selector, single) {
		this.__selectorQuery = selectorQuery
		this.__moduleId = componentId
		this.__selector = selector
		this.__single = single
	}

	/**
	 * 获取节点的相关信息。需要获取的字段在fields中指定。返回值是 nodesRef 对应的 selectorQuery
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.fields.html
	 */
	fields(fields, callback) {
		this.__selectorQuery.__push(this.__selector, this.__moduleId, this.__single, fields, callback)
		return this.__selectorQuery
	}

	/**
	 * 添加节点的布局位置的查询请求。相对于显示区域，以像素为单位。其功能类似于 DOM 的 getBoundingClientRect。返回 NodesRef 对应的 SelectorQuery
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.boundingClientRect.html
	 */
	boundingClientRect(callback) {
		return this.fields(
			{
				id: true,
				dataset: true,
				rect: true,
				size: true,
			},
			callback,
		)
	}

	/**
	 * 添加节点的 Context 对象查询请求。
	 * 目前支持 VideoContext、CanvasContext、LivePlayerContext、EditorContext和 MapContext 的获取。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.context.html
	 */
	context(callback) {
		return this.fields(
			{
				context: true,
			},
			callback,
		)
	}

	/**
	 * 获取 Node 节点实例
	 * 目前支持 Canvas 和 ScrollViewContext 的获取。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.node.html
	 */
	node(callback) {
		// node 节点对应的 Node 实例
		return this.fields(
			{
				node: true,
			},
			callback,
		)
	}

	/**
	 * 添加节点的滚动位置查询请求。以像素为单位。节点必须是 scroll-view 或者 viewport，返回 NodesRef 对应的 SelectorQuery。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.scrollOffset.html
	 */
	scrollOffset(callback) {
		// id, dataset, scrollLeft, scrollTop
		return this.fields(
			{
				id: true,
				dataset: true,
				scrollOffset: true,
			},
			callback,
		)
	}
}
