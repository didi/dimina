import { invokeAPI } from '@/api/common'

/**
 * 文件系统
 * https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html
 *
 * 环境变量
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.env.html
 */
export function env() {
	return {
		USER_DATA_PATH: 'difile://',
	}
}

// JS 层内置支持的API列表
const builtInAPIs = new Set([
	'nextTick',
	'getUpdateManager',
	'UpdateManager',
	'UpdateManager.applyUpdate',
	'UpdateManager.onCheckForUpdate',
	'UpdateManager.onUpdateFailed',
	'UpdateManager.onUpdateReady',
	'getPerformance'
])
	
/**
 * 判断小程序的API，回调，参数，组件等是否在当前版本可用。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.canIUse.html
 */
export function canIUse(schema) {
	if (builtInAPIs.has(schema)) {
		return true
	}
	try {
		return invokeAPI('canIUse', schema)
	} catch (error) {
		console.warn(`[canIUse] check ${schema} error:`, error)
		return false
	}
}
