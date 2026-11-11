import { invokeAPI } from '@/api/common'
import { createStorageEntry, decodeStorageEntry, decodeStorageResult } from '@dimina/common'
import { invokeSafely } from '@/core/safe-callback'

function rejectStorageWrite(opts, error) {
	const result = { errMsg: `setStorage:fail ${error.message}` }
	if (opts && ['success', 'fail', 'complete'].some(key => Object.hasOwn(opts, key))) {
		invokeSafely(undefined, opts.fail, [result], 'setStorage fail')
		invokeSafely(undefined, opts.complete, [result], 'setStorage complete')
		return
	}
	return Promise.reject(result)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.setStorageSync.html
 */
export function setStorageSync(key, data = '') {
	if (typeof key !== 'string') {
		console.error(`setStorageSync:fail the first parameter should be a string instead of ${Object.prototype.toString.call(key).slice(8, -1)}`)
		return
	}
	const record = createStorageEntry(key, data)
	const result = invokeAPI('setStorageSync', [key, decodeStorageEntry(record), { __diminaStorageWire: record }])
	if (result?.__diminaStorageError) throw new Error(`setStorageSync:fail ${result.__diminaStorageError}`)
}

/**
 * 从本地缓存中同步获取指定 key 的内容。
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorageSync.html
 */
export function getStorageSync(opts) {
	if (typeof opts !== 'string') return
	return decodeStorageResult(invokeAPI('getStorageSync', { key: opts, __diminaStorageWire: true }, 'container', false))
}

/**
 *
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.removeStorageSync.html
 */
export function removeStorageSync(opts) {
	invokeAPI('removeStorageSync', opts)
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.clearStorageSync.html
 */
export function clearStorageSync() {
	invokeAPI('clearStorageSync')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.setStorage.html
 */
export function setStorage(opts) {
	let record
	try {
		if (typeof opts?.key !== 'string') throw new Error('parameter.key should be String')
		record = createStorageEntry(opts.key, opts.data)
	}
	catch (error) {
		return rejectStorageWrite(opts, error)
	}
	return invokeAPI('setStorage', { ...opts, data: decodeStorageEntry(record), __diminaStorageWire: record })
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.getStorage.html
 */
export function getStorage(opts) {
	const decode = result => result && Object.hasOwn(result, 'data')
		? { ...result, data: decodeStorageResult(result.data) }
		: result
	const params = { ...opts, __diminaStorageWire: true }
	for (const key of ['success', 'complete']) {
		if (typeof opts?.[key] === 'function') params[key] = result => opts[key](decode(result))
	}
	const result = invokeAPI('getStorage', params)
	return result && typeof result.then === 'function' ? result.then(decode) : result
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/storage/wx.removeStorage.html
 */
export function removeStorage(opts) {
	return invokeAPI('removeStorage', opts)
}

export function clearStorage(opts) {
	return invokeAPI('clearStorage', opts)
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
