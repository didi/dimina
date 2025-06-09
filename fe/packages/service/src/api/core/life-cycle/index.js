import runtime from '@/core/runtime'

/**
 * 获取小程序启动时的参数。与 App.onLaunch 的回调参数一致
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/life-cycle/wx.getLaunchOptionsSync.html
 */
export function getLaunchOptionsSync() {
	return runtime.app?.options
}

/**
 * 获取本次小程序启动时的参数。如果当前是冷启动，则返回值与 App.onLaunch 的回调参数一致；如果当前是热启动，则返回值与 App.onShow 一致。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/app/life-cycle/wx.getEnterOptionsSync.html
 */
export function getEnterOptionsSync() {
	return runtime.app?.options
}
