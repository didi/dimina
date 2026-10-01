import { invokeAPI } from '@/api/common'
import { fileSystemManagerAPINames, VIRTUAL_FILE_PREFIX } from '@/api/core/file'
import { updateManagerAPINames } from '@/api/core/base/update/api-names'

/**
 * 环境变量
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.env.html
 */
export const env = {
	USER_DATA_PATH: `${VIRTUAL_FILE_PREFIX}usr`,
}

// JS 层内置支持的API列表
const builtInAPIs = new Set([
	'nextTick',
	'onError',
	'offError',
	'onAppShow',
	'onAppHide',
	'offAppShow',
	'offAppHide',
	'onShow',
	'offShow',
	'onHide',
	'offHide',
	'createCanvas',
	'createImage',
	'onTouchStart',
	'offTouchStart',
	'onTouchMove',
	'offTouchMove',
	'onTouchEnd',
	'offTouchEnd',
	'onTouchCancel',
	'offTouchCancel',
	'getUpdateManager',
	'UpdateManager',
	...updateManagerAPINames.map(name => `UpdateManager.${name}`),
	'getPerformance',
	'getFileSystemManager',
	'FileSystemManager',
	...fileSystemManagerAPINames.map(name => `FileSystemManager.${name}`),
])

// Native object factories live in the service layer, while their capability is
// provided by the native object methods. Probe a representative native method
// so canIUse stays platform-aware (notably, it remains false on Web).
const nativeBackedFactorySchemas = {
	createVideoDecoder: 'VideoDecoder.start',
	VideoDecoder: 'VideoDecoder.start',
	'VideoDecoder.on': 'VideoDecoder.start',
	'VideoDecoder.off': 'VideoDecoder.start',
	createUDPSocket: 'UDPSocket.bind',
	UDPSocket: 'UDPSocket.bind',
	createTCPSocket: 'TCPSocket.connect',
	TCPSocket: 'TCPSocket.connect',
}
	
/**
 * 判断小程序的API，回调，参数，组件等是否在当前版本可用。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.canIUse.html
 */
export function canIUse(schema) {
	if (schema === 'WXWebAssembly') return typeof globalThis.WXWebAssembly?.instantiate === 'function'
	if (typeof schema === 'string' && schema.startsWith('WXWebAssembly.')) return typeof globalThis.WXWebAssembly?.[schema.slice(14)] === 'function'
	if (builtInAPIs.has(schema)) {
		return true
	}
	try {
		const nativeSchema = Object.hasOwn(nativeBackedFactorySchemas, schema)
			? nativeBackedFactorySchemas[schema]
			: schema
		return invokeAPI('canIUse', nativeSchema) === true
	} catch (error) {
		console.warn(`[canIUse] check ${schema} error:`, error)
		return false
	}
}
