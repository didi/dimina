import { invokeAPI } from '@/api/common'

/**
 * 跳转系统蓝牙设置页。仅支持安卓
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.openSystemBluetoothSetting.html
 */
export function openSystemBluetoothSetting(opts) {
	invokeAPI('openSystemBluetoothSetting', opts)
}

/**
 * 获取窗口信息
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getWindowInfo.html
 */
export function getWindowInfo(opts) {
	return invokeAPI('getWindowInfo', opts)
}

/**
 * 跳转系统授权管理页
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.openAppAuthorizeSetting.html
 */
export function openAppAuthorizeSetting(opts) {
	invokeAPI('openAppAuthorizeSetting', opts)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getSystemInfo.html
 */
export function getSystemInfo(opts) {
	return new Promise((resolve) => {
		resolve(invokeAPI('getSystemInfo', opts))
	})
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getSystemInfoSync.html
 */
export function getSystemInfoSync() {
	if (globalThis.injectInfo) {
		return globalThis.injectInfo.systemInfo
	}
	return invokeAPI('getSystemInfoSync')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getSystemInfoAsync.html
 */
export function getSystemInfoAsync(opts) {
	invokeAPI('getSystemInfoAsync', opts)
}
