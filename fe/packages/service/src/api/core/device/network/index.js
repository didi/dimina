import { invokeAPI } from '@/api/common'

/**
 * 获取网络类型
 *	https://developers.weixin.qq.com/miniprogram/dev/api/device/network/wx.getNetworkType.html
 * @param {*} opts
 */
export function getNetworkType(opts) {
	return invokeAPI('getNetworkType', opts)
}
