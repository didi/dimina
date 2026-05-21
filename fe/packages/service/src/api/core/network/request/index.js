import { invokeAPI } from '@/api/common'

/**
 * 发起 HTTPS 网络请求
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html
 * @param {*} opts
 */
export function request(opts) {
	return invokeAPI('request', opts)
}
