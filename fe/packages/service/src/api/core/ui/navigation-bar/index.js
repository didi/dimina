import { invokeAPI } from '@/api/common'

/**
 * 在当前页面显示导航条加载动画
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/navigation-bar/wx.showNavigationBarLoading.html
 */
export function showNavigationBarLoading(opts) {
	return invokeAPI('showNavigationBarLoading', opts)
}

/**
 * 动态设置当前页面的标题
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/navigation-bar/wx.setNavigationBarTitle.html
 */
export function setNavigationBarTitle(opts) {
	return invokeAPI('setNavigationBarTitle', opts)
}

/**
 * 设置页面导航条颜色
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/navigation-bar/wx.setNavigationBarColor.html
 */
export function setNavigationBarColor(opts) {
	return invokeAPI('setNavigationBarColor', opts)
}

/**
 * 在当前页面隐藏导航条加载动画
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/navigation-bar/wx.hideNavigationBarLoading.html
 */
export function hideNavigationBarLoading(opts) {
	return invokeAPI('hideNavigationBarLoading', opts)
}
