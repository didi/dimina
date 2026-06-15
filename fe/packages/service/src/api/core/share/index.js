import { invokeAPI } from '@/api/common'

/**
 * 显示当前页面的转发按钮
 * https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.showShareMenu.html
 */
export function showShareMenu(opts) {
	return invokeAPI('shareShareMenu', opts)
}

/**
 * 打开分享图片弹窗，可以将图片发送给朋友、收藏或下载
 * https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.showShareImageMenu.html
 */
export function showShareImageMenu(opts) {
	return invokeAPI('showShareImageMenu', opts)
}

/**
 * 隐藏当前页面的转发按钮
 * https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.hideShareMenu.html
 */
export function hideShareMenu(opts) {
	return invokeAPI('hideShareMenu', opts)
}
