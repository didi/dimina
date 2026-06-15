import { invokeAPI } from '@/api/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/phone/wx.makePhoneCall.html
 */
export function makePhoneCall(opts) {
	return invokeAPI('makePhoneCall', opts)
}
