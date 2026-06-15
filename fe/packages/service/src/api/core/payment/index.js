import { invokeAPI } from '@/api/common'

/**
 * 发起支付
 * https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestPayment.html
 */
export function requestPayment(opts) {
	return invokeAPI('requestPayment', opts)
}
