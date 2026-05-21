import { invokeAPI } from '@/api/common'

/**
 * 设置系统剪贴板的内容。调用成功后，会弹出 toast 提示"内容已复制"，持续 1.5s
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/clipboard/wx.setClipboardData.html
 */
export function setClipboardData(opts) {
	return invokeAPI('setClipboardData', opts)
}

/**
 * 获取系统剪贴板的内容
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/clipboard/wx.getClipboardData.html
 */
export function getClipboardData(opts) {
	return invokeAPI('getClipboardData', opts)
}
