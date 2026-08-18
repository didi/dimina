import {
	offAppError,
	offAppHideEvent,
	offAppShowEvent,
	onAppError,
	onAppHideEvent,
	onAppShowEvent,
} from '@/core/app-events'

/**
 * 监听小程序错误事件。如脚本错误或 API 调用报错等。该事件与 App.onError 的回调时机与参数一致。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onError.html
 */
export function onError(callback) {
	onAppError(callback)
}

/**
 * 移除小程序错误事件的监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.offError.html
 */
export function offError(callback) {
	offAppError(callback)
}

/**
 * 监听小程序切前台事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onAppShow.html
 */
export function onAppShow(callback) {
	onAppShowEvent(callback)
}

/**
 * 监听小程序切后台事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onAppHide.html
 */
export function onAppHide(callback) {
	onAppHideEvent(callback)
}

/**
 * 移除小程序切前台事件的监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.offAppShow.html
 */
export function offAppShow(callback) {
	offAppShowEvent(callback)
}

/**
 * 移除小程序切后台事件的监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.offAppHide.html
 */
export function offAppHide(callback) {
	offAppHideEvent(callback)
}

// 微信小游戏使用 wx.onShow/wx.onHide；事件源与小程序的
// wx.onAppShow/wx.onAppHide 相同，别名共用同一组监听。
export function onShow(callback) {
	onAppShowEvent(callback)
}

export function offShow(callback) {
	offAppShowEvent(callback)
}

export function onHide(callback) {
	onAppHideEvent(callback)
}

export function offHide(callback) {
	offAppHideEvent(callback)
}

/**
 * 监听未处理的 Promise 拒绝事件。该事件与 App.onUnhandledRejection 的回调时机与参数一致。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onUnhandledRejection.html
 */
export function onUnhandledRejection() {}

/**
 * 监听小程序要打开的页面不存在事件。该事件与 App.onPageNotFound 的回调时机一致。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onPageNotFound.html
 */
export function onPageNotFound() {}

/**
 * 小程序隐藏API - onAppRoute(eventListener) | 微信开放社区
 * https://developers.weixin.qq.com/community/develop/article/doc/00006c80998d182690edbb60c56413
 */
export function onAppRoute() {}
