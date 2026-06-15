import { invokeAPI } from '@/api/common'

/**
 * 监听内存不足告警事件。
 * 当 iOS/Android 向小程序进程发出内存警告时，触发该事件。触发该事件不意味小程序被杀，大部分情况下仅仅是告警，开发者可在收到通知后回收一些不必要资源避免进一步加剧内存紧张。
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/memory/wx.onMemoryWarning.html
 */
export function onMemoryWarning(opts) {
	return invokeAPI('onMemoryWarning', opts)
}

/**
 * 移除内存不足告警事件的监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/memory/wx.offMemoryWarning.html
 */
export function offMemoryWarning(opts) {
	return invokeAPI('offMemoryWarning', opts)
}
