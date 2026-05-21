import { invokeAPI } from '@/api/common'

/**
 * 使手机发生较短时间的振动（15 ms）
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateShort.html
 */
export function vibrateShort(opts) {
	return invokeAPI('vibrateShort', opts)
}

/**
 * 使手机发生较长时间的振动（400 ms)
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateLong.html
 */
export function vibrateLong(opts) {
	return invokeAPI('vibrateLong', opts)
}
