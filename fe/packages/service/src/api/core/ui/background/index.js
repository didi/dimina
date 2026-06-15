import { invokeAPI } from '@/api/common'

/**
 * 动态设置下拉背景字体、loading 图的样式
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/background/wx.setBackgroundTextStyle.html
 */
export function setBackgroundTextStyle(opts) {
	return invokeAPI('setBackgroundTextStyle', opts)
}

/**
 * 动态设置窗口的背景色
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/background/wx.setBackgroundColor.html
 */
export function setBackgroundColor(opts) {
	return invokeAPI('setBackgroundColor', opts)
}
