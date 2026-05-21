import { invokeAPI } from '@/api/common'

/**
 * 拉起手机通讯录，选择联系人
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/contact/wx.chooseContact.html
 */
export function chooseContact(opts) {
	return invokeAPI('chooseContact', opts)
}

/**
 * 添加手机通讯录联系人。用户可以选择将该表单以「新增联系人」或「添加到已有联系人」的方式，写入手机系统通讯录。
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/contact/wx.addPhoneContact.html
 */
export function addPhoneContact(opts) {
	return invokeAPI('addPhoneContact', opts)
}
