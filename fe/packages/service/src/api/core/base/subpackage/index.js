import { invokeAPI } from '@/api/common'

/**
 * 触发分包预下载，只下载代码包，不自动执行代码
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/subpackage/wx.preDownloadSubpackage.html
 */
export function preDownloadSubpackage(opts) {
	return invokeAPI('preDownloadSubpackage', opts)
}

/**
 * 触发分包加载
 * https://developers.weixin.qq.com/minigame/dev/api/base/subpackage/wx.loadSubpackage.html
 */
export function loadSubpackage(opts) {
	return invokeAPI('loadSubpackage', opts)
}
