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
 * 查找最近的可滚动容器元素
 */
function isScrollable(element) {
	const isElementScrollable = (el) => {
		const style = window.getComputedStyle(el)
		const overflowY = style.overflowY
		const overflowX = style.overflowX
		return ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
			|| ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth)
	}

	let current = element
	while (current && current !== document.body) {
		if (isElementScrollable(current)) {
			return true
		}
		current = current.parentElement
	}

	return false
}

/**
 * touchstart, touchmove, touchcancel, touchend, tap, longpress
 * @param {*} type
 * @param {*} any
 */
function triggerEvent(type, { event, detail, info, success }) {
	if (!info.attrs) {
		return
	}

	// 遍历一次attrs，分别获取bind和catch的处理方法
	const bindHandler = info.attrs[`bind${type}`] || info.attrs[`bind:${type}`]
	const catchHandler = info.attrs[`catch${type}`] || info.attrs[`catch:${type}`]

	// 如果有catch处理器，阻止冒泡并只执行catch
	if (catchHandler) {
		// 阻止事件冒泡
		if (event) {
			event.stopPropagation()
			if (type.startsWith('touch')) {
				if (!isScrollable(event.target)) {
					// 阻止默认滚动
					event.preventDefault()
				}
			}
		}
		sendTriggerEvent(catchHandler, {
			type,
			detail,
			info,
			success,
			event,
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
		})
	}
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxml/event.html
 * @param {*} methodName
 * @param {*} param
 */
function sendTriggerEvent(methodName, { type, detail = {}, info, success, event = {} }) {
	const { bridgeId, moduleId } = info
	const { currentTarget, target, pageX, pageY, changedTouches = [], touches = [] } = event

	if (pageX !== undefined && pageY !== undefined) {
		detail.x = pageX
		detail.y = pageY
	}

	const currentTargetInfo = currentTarget
		? {
				id: currentTarget.id,
				dataset: { ...currentTarget.dataset, ...currentTarget._ds },
				offsetLeft: currentTarget.offsetLeft,
				offsetTop: currentTarget.offsetTop,
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

	const successId = success && window.__callback.store(success)
	window.__message.send({
		type: 't',
		target: 'service',
		body: {
			bridgeId,
			moduleId,
			methodName,
			success: successId,
			event: {
				type, // 代表事件的类型
				timeStamp: Date.now() - initTimeStamp, // 页面打开到触发事件所经过的毫秒数
				detail, // 自定义事件所携带的数据
				currentTarget: currentTargetInfo, // 当前处理事件的元素（即绑定事件监听器的元素）
				target: targetInfo,	// 触发事件的元素
				changedTouches: Array.from(changedTouches).map(touch => ({
					clientX: touch.clientX,
					clientY: touch.clientY,
					force: touch.force,
					identifier: touch.identifier,
					pageX: touch.pageX,
					pageY: touch.pageY,
					screenX: touch.screenX,
					screenY: touch.screenY,
				})),
				touches: Array.from(touches).map(touch => ({
					clientX: touch.clientX,
					clientY: touch.clientY,
					force: touch.force,
					identifier: touch.identifier,
					pageX: touch.pageX,
					pageY: touch.pageY,
					screenX: touch.screenX,
					screenY: touch.screenY,
				})),
			},
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

export { hasCatchEvent, hasEvent, invokeAPI, invokeAPIWithCallback, offEvent, onEvent, triggerEvent, useInfo }
