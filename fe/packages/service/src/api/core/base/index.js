import { invokeAPI } from '@/api/common'
import { fileSystemManagerAPINames } from '@/api/core/file'
import { updateManagerAPINames } from '@/api/core/base/update/api-names'

/**
 * 环境变量
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.env.html
 */
export const env = {
	USER_DATA_PATH: 'difile://usr',
}

// JS 层内置支持的API列表
const builtInAPIs = new Set([
	'nextTick',
	'getUpdateManager',
	'UpdateManager',
	...updateManagerAPINames.map(name => `UpdateManager.${name}`),
	'getPerformance',
	'getFileSystemManager',
	'FileSystemManager',
	...fileSystemManagerAPINames.map(name => `FileSystemManager.${name}`),
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
