import { invokeAPI } from '@/api/common'

/**
 * 界面 / 滚动 / wx.pageScrollTo
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/scroll/wx.pageScrollTo.html
 */
export function pageScrollTo(opts) {
	return invokeAPI('pageScrollTo', opts)
}
