import { invokeAPI } from '@/api/common'

/**
 * 调用接口获取登录凭证
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html
 * @param {*} opts
 */
export function login(opts) {
	return invokeAPI('login', opts)
}
