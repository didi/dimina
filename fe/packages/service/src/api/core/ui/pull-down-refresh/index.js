import { invokeAPI } from '@/api/common'

/**
 * 停止当前页面下拉刷新
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/pull-down-refresh/wx.stopPullDownRefresh.html
 */
export function stopPullDownRefresh(opts) {
	return invokeAPI('stopPullDownRefresh', opts)
}

/**
 *	开始下拉刷新。调用后触发下拉刷新动画，效果与用户手动下拉刷新一致
 *	https://developers.weixin.qq.com/miniprogram/dev/api/ui/pull-down-refresh/wx.startPullDownRefresh.html
 */
export function startPullDownRefresh(opts) {
	return invokeAPI('startPullDownRefresh', opts)
}
