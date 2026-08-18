import { invokeAPI } from '@/api/common'
import { isFunction } from '@dimina/common'
import hostEnv from '@/core/host-env'

const themeChangeCallbacks = new Set()

hostEnv.onUpdate((patch) => {
	const theme = patch.systemInfo?.theme
	if (!theme) {
		return
	}
	themeChangeCallbacks.forEach(callback => callback({ theme }))
})

/**
 * 跳转系统蓝牙设置页。仅支持安卓
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.openSystemBluetoothSetting.html
 */
export function openSystemBluetoothSetting(opts) {
	return invokeAPI('openSystemBluetoothSetting', opts)
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
	return invokeAPI('openAppAuthorizeSetting', opts)
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
	return invokeAPI('getSystemInfoSync')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getSystemInfoAsync.html
 */
export function getSystemInfoAsync(opts) {
	return invokeAPI('getSystemInfoAsync', opts)
}

export function getAppBaseInfo() {
	return invokeAPI('getAppBaseInfo')
}

export function getDeviceInfo() {
	return invokeAPI('getDeviceInfo')
}

export function onThemeChange(callback) {
	if (isFunction(callback)) {
		themeChangeCallbacks.add(callback)
	}
}

export function offThemeChange(callback) {
	if (isFunction(callback)) {
		themeChangeCallbacks.delete(callback)
	}
	else {
		themeChangeCallbacks.clear()
	}
}
