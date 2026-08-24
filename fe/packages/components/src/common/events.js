const initTimeStamp = Date.now()

function useInfo() {
	const bridgeId = inject('bridgeId')
	const currPath = inject('path')
	const info = inject(currPath)
	let moduleId
	let path
	const instance = getCurrentInstance()

	const scopeIds = instance.vnode.slotScopeIds
	if (scopeIds?.length) {
		// 当前组件实例作为插槽内容渲染时，组件信息取引入该组件的自定义组件的页面信息
		// 由于存在嵌套的情况，所以需要覆写组件信息
		// 获取组件的插槽作用域 ID
		let currentInfo = info
		let currentPath = currPath

		// 通过 slotScopeIds 长度判断插槽嵌套层级
		for (let i = 0; i < scopeIds.length; i++) {
			if (!currentInfo?.pagePath)
				break

			const parentPath = currentInfo.pagePath
			const parentInfo = inject(parentPath)
			if (!parentInfo)
				break

			currentInfo = parentInfo
			currentPath = parentPath
		}

		// 更新路径注入
		provide('path', currentPath)
		provide(currentPath, currentInfo)

		moduleId = currentInfo.id
		path = currentPath
	}
	else {
		moduleId = info.id
		path = currPath
	}

	return {
		attrs: useAttrs(),
		bridgeId,
		moduleId,
		path,
	}
}

/**
 * touchstart, touchmove, touchcancel, touchend, tap, longpress
 * @param {*} type
 * @param {*} any
 */
function triggerEvent(type, { event, detail, info, success, currentTarget }) {
	if (!info.attrs) {
		return
	}

	// 遍历一次attrs，分别获取bind和catch的处理方法
	const bindHandler = info.attrs[`bind${type}`] || info.attrs[`bind:${type}`]
	const catchHandler = info.attrs[`catch${type}`] || info.attrs[`catch:${type}`]

	// 如果有catch处理器，阻止冒泡并只执行catch
	if (catchHandler) {
		// catch 只管理小程序事件传播。原生滚动是否可继续由触摸状态机
		// 在 catchtouchmove 上结合方向、边界和嵌套滚动容器统一裁决。
		event?.stopPropagation()
		sendTriggerEvent(catchHandler, {
			type,
			detail,
			info,
			success,
			event,
			currentTarget,
		})
		return
	}

	// 没有catch时，执行bind
	if (bindHandler) {
		sendTriggerEvent(bindHandler, {
			type,
			detail,
			info,
			success,
			event,
			currentTarget,
		})
	}
}

/**
 * 把一个触摸点整理成小程序侧的 Touch 对象。
 * 带 x / y 的触摸点对应官方的 CanvasTouch 对象，x / y 是相对画布左上角的坐标。
 * https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxml/event.html
 */
function mapTouchPoint(touch) {
	const point = {
		clientX: touch.clientX,
		clientY: touch.clientY,
		force: touch.force,
		identifier: touch.identifier,
		pageX: touch.pageX,
		pageY: touch.pageY,
		screenX: touch.screenX,
		screenY: touch.screenY,
	}
	if (touch.x !== undefined && touch.y !== undefined) {
		point.x = touch.x
		point.y = touch.y
	}
	return point
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxml/event.html
 * @param {*} methodName
 * @param {*} param
 * @param {Element} [param.currentTarget] 覆盖事件自带的 currentTarget，供容器组件转发子项事件时使用
 */
function sendTriggerEvent(methodName, { type, detail = {}, info, success, event = {}, currentTarget }) {
	const { target, pageX, pageY, changedTouches = [], touches = [] } = event
	const { bridgeId, moduleId } = info
	// 容器组件（radio-group、checkbox-group 等）用子项的那次事件派发自己的事件，
	// 而 currentTarget 按定义是绑定处理器的那个元素，所以由容器显式给出自己的根元素。
	const currentTargetElement = currentTarget ?? event.currentTarget

	if (pageX !== undefined && pageY !== undefined) {
		detail.x = pageX
		detail.y = pageY
	}

	const currentTargetInfo = currentTargetElement
		? {
				id: currentTargetElement.id,
				dataset: { ...currentTargetElement.dataset, ...currentTargetElement._ds },
				offsetLeft: currentTargetElement.offsetLeft,
				offsetTop: currentTargetElement.offsetTop,
			}
		: {}
	const targetInfo = target
		? {
				id: target.id,
				dataset: { ...target.dataset, ...target._ds },
				offsetLeft: target.offsetLeft,
				offsetTop: target.offsetTop,
			}
		: {}

	const eventPayload = {
		type, // 代表事件的类型
		timeStamp: Date.now() - initTimeStamp, // 页面打开到触发事件所经过的毫秒数
		detail, // 自定义事件所携带的数据
		currentTarget: currentTargetInfo, // 当前处理事件的元素（即绑定事件监听器的元素）
		target: targetInfo,	// 触发事件的元素
		changedTouches: Array.from(changedTouches).map(mapTouchPoint),
		touches: Array.from(touches).map(mapTouchPoint),
	}
	const successId = success && window.__callback.store(success)
	window.__message.send({
		type: 't',
		target: 'service',
		body: {
			bridgeId,
			moduleId,
			methodName,
			success: successId,
			event: eventPayload,
		},
	})
}

function invokeAPI(apiName, { params, bridgeId }) {
	window.__message.invoke({
		type: 'invokeAPI',
		target: 'container',
		body: {
			name: apiName,
			bridgeId,
			params,
		},
	})
}

/**
 * Invokes a container API from the render thread and routes callbacks back to
 * the render callback registry through the service thread.
 */
function invokeAPIWithCallback(apiName, { params = {}, bridgeId, success, fail, complete }) {
	let successId
	let failId
	let completeId
	const callbackRegistry = window.__callback

	if (success) successId = callbackRegistry.store(success)
	if (fail) failId = callbackRegistry.store(fail)
	completeId = callbackRegistry.store((data) => {
		complete?.(data)
		callbackRegistry.remove(successId)
		callbackRegistry.remove(failId)
	})

	window.__message.send({
		type: 'componentInvokeAPI',
		target: 'service',
		body: {
			apiName,
			bridgeId,
			callbacks: { complete: completeId, fail: failId, success: successId },
			params,
		},
	})
}

function onEvent(eventName, callback) {
	const handler = (msg) => {
		callback?.(msg)
	}
	window.__message.on(eventName, handler)
	return () => window.__message.off(eventName, handler)
}

function offEvent(eventName, callback) {
	window.__message.off(eventName, callback)
}

/**
 * 检查元素是否有指定事件类型的相关属性
 * @param {object} info 组件信息对象
 * @param {string} eventType 事件类型，默认为 'tap'
 * @returns {boolean} 是否有相关属性
 */
function hasEvent(info, eventType = 'tap') {
	const attrs = info.attrs || {}
	return !!(attrs[`bind${eventType}`] || attrs[`bind:${eventType}`] || attrs[`catch${eventType}`] || attrs[`catch:${eventType}`])
}

/**
 * 检查元素是否有指定事件类型的catch属性，支持写法：catchtouchstart、catch:touchstart
 * @param {object} info 组件信息对象
 * @param {string} eventType 事件类型，默认为 'tap'
 * @returns {boolean} 是否有catch属性
 */
function hasCatchEvent(info, eventType = 'tap') {
	const attrs = info.attrs || {}
	return !!(attrs[`catch${eventType}`] || attrs[`catch:${eventType}`])
}

// 全部由 useTouchEvents 统一派发的手势事件
const INTERACTION_EVENTS = ['tap', 'longpress', 'longtap', 'canceltap', 'touchstart', 'touchmove', 'touchend', 'touchcancel']

/**
 * 组件是否绑定了任意手势事件，决定要不要安装 useTouchEvents
 * @param {object} info 组件信息对象
 * @returns {boolean} 是否绑定了任意手势事件
 */
function hasInteractionEvent(info) {
	return INTERACTION_EVENTS.some(eventType => hasEvent(info, eventType))
}

export { hasCatchEvent, hasEvent, hasInteractionEvent, invokeAPI, invokeAPIWithCallback, offEvent, onEvent, triggerEvent, useInfo }
