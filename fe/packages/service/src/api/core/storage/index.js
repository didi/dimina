import { invokeAPI } from '@/api/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.setStorageSync.html
 */
export function setStorageSync(...opts) {
	return invokeAPI('setStorageSync', opts)
}

/**
 * 从本地缓存中同步获取指定 key 的内容。
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorageSync.html
 */
export function getStorageSync(opts) {
	return invokeAPI('getStorageSync', opts)
}

/**
 *
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.removeStorageSync.html
 */
export function removeStorageSync(opts) {
	return invokeAPI('removeStorageSync', opts)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.clearStorageSync.html
 */
export function clearStorageSync() {
	return invokeAPI('clearStorageSync')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.setStorage.html
 */
export function setStorage(opts) {
	return invokeAPI('setStorage', opts)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorage.html
 */
export function getStorage(opts) {
	return invokeAPI('getStorage', opts)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.removeStorage.html
 */
export function removeStorage(opts) {
	return invokeAPI('removeStorage', opts)
}

export function clearStorage() {
	return invokeAPI('clearStorage')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorageInfoSync.html
 */
export function getStorageInfoSync() {
	return invokeAPI('getStorageInfoSync')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorageInfo.html
 */
export function getStorageInfo(opts) {
	return invokeAPI('getStorageInfo', opts)
}
