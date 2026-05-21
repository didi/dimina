import { invokeAPI } from '@/api/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/scan/wx.scanCode.html
 */
export function scanCode(opts) {
	return invokeAPI('scanCode', opts)
}
