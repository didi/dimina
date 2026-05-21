import { invokeAPI } from '@/api/common'

/**
 * 拍摄视频或从手机相册中选视频
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseVideo.html
 */
export function chooseVideo(opts) {
	return invokeAPI('chooseVideo', opts)
}

/**
 * 拍摄或从手机相册中选择图片或视频
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html
 */
export function chooseMedia(opts) {
	return invokeAPI('chooseMedia', opts)
}
