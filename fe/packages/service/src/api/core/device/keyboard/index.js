import { invokeAPI } from '@/api/common'

/**
 * 在input、textarea等focus拉起键盘之后，手动调用此接口收起键盘
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/keyboard/wx.hideKeyboard.html
 */
export function hideKeyboard(opts) {
	return invokeAPI('hideKeyboard', opts)
}
