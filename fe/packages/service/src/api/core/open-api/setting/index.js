import { invokeAPI } from '@/api/common'

/**
 * 调起客户端小程序设置界面，返回用户设置的操作结果
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/setting/wx.openSetting.html
 */
export function openSetting(opts) {
	return invokeAPI('openSetting', opts)
}

/**
 * 获取用户的当前设置
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/setting/wx.getSetting.html
 */
export function getSetting(opts) {
	return invokeAPI('getSetting', opts)
}
