import { invokeAPI } from '@/api/common'

/**
 *将本地资源上传到服务器
 *https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html
 */
export function uploadFile(opts) {
	return invokeAPI('uploadFile', opts)
}
