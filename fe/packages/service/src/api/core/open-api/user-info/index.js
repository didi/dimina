import { invokeAPI } from '@/api/common'

/**
 * 获取用户信息
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/user-info/wx.getUserInfo.html
 * @param {*} opts
 */
export function getUserInfo(opts) {
	return invokeAPI('getUserInfo', opts)
}
