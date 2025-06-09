import { invokeAPI } from '@/api/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html
 */
export function login(opts) {
	invokeAPI('login', opts)
}
