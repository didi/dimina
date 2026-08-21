import { callback, isFunction } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import {
	deleteWindowResizeListenerId,
	getWindowResizeListenerId,
	setWindowResizeListenerId,
	takeAllWindowResizeListenerIds,
} from '@/core/window-resize-listeners'

/**
 * 监听窗口尺寸变化事件。
 * 该监听是持久的，直到调用 offWindowResize 移除。
 * listener 非函数（如显式传 null）时按未传处理，不透传给 invokeAPI，避免 invokeAPI 内部对 null 做 hasOwnProperty 检测时抛错。
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/window/wx.onWindowResize.html
 */
export function onWindowResize(listener) {
	if (!isFunction(listener)) {
		return invokeAPI('onWindowResize', undefined)
	}
	const registered = getWindowResizeListenerId(listener)
	if (registered !== undefined) {
		return invokeAPI('onWindowResize', { success: registered })
	}
	// 存包装函数而不是 listener 本身：callback.store 的 keep 去重是跨 API 全局按函数身份做的，直接存 listener 会与其他 keep API（如 onLocationChange）登记的同一个函数共用一条记录，off 掉这边就把那边的监听也删了。
	// 包装函数每次注册都是新对象，这条记录只属于 onWindowResize。
	const evtId = callback.store(detail => listener(detail), true)
	setWindowResizeListenerId(listener, evtId)
	return invokeAPI('onWindowResize', { success: evtId })
}

/**
 * 移除窗口尺寸变化事件的监听函数。
 * 传入的 listener 必须与注册时是同一个函数引用，才能在 listenerIds 里查到对应的 evtId；查不到（未注册过，或已经 off 过一次）时直接返回，不产生新的 callback，也不打扰容器侧。
 * 不传 listener 时按微信语义移除该 API 名下的所有监听函数。
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/window/wx.offWindowResize.html
 */
export function offWindowResize(listener) {
	if (!isFunction(listener)) {
		const evtIds = takeAllWindowResizeListenerIds()
		evtIds.forEach(evtId => callback.remove(evtId))
		return invokeAPI('offWindowResize', undefined)
	}
	const evtId = getWindowResizeListenerId(listener)
	if (evtId === undefined) {
		return undefined
	}
	deleteWindowResizeListenerId(listener)
	callback.remove(evtId)
	return invokeAPI('offWindowResize', { success: evtId })
}
