import { invokeAPI } from '@/api/common'

/**
 * 下载文件资源到本地
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html
 * @param {*} opts
 */
export function downloadFile(opts) {
	return invokeAPI('downloadFile', opts)
}
