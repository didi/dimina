import { parsePath } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import router from '@/core/router'

/**
 * 跳转到 tabBar 页面，并关闭其他所有非 tabBar 页面
 * https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.switchTab.html
 * @param {*} opts
 */
export function switchTab(opts) {
	opts.url = parsePath(router.getPageInfo().route, opts.url)
	return invokeAPI('switchTab', opts)
}

/**
 * 关闭所有页面，打开到应用内的某个页面
 * https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.reLaunch.html
 * @param {*} opts
 */
export function reLaunch(opts) {
	opts.url = parsePath(router.getPageInfo().route, opts.url)
	return invokeAPI('reLaunch', opts)
}

/**
 * 关闭当前页面，跳转到应用内的某个页面。但是不允许跳转到 tabbar 页面。
 * https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.redirectTo.html
 * @param {*} opts
 */
export function redirectTo(opts) {
	const url = parsePath(router.getPageInfo().route, opts.url)
	if (router.getPageInfo().route === url) {
		return
	}
	opts.url = url
	return invokeAPI('redirectTo', opts)
}

/**
 * 保留当前页面，跳转到应用内的某个页面。但是不能跳到 tabbar 页面
 * https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.navigateTo.html
 * @param {*} opts
 */
export function navigateTo(opts) {
	opts.url = parsePath(router.getPageInfo().route, opts.url)
	return invokeAPI('navigateTo', opts)
}

/**
 * 关闭当前页面，返回上一页面或多级页面。可通过 getCurrentPages 获取当前的页面栈，决定需要返回几层。
 * https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.navigateBack.html
 * @param {*} opts
 */
export function navigateBack(opts) {
	return invokeAPI('navigateBack', opts)
}
