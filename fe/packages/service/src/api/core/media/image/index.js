import { invokeAPI } from '@/api/common'

/**
 * 保存图片到系统相册
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.saveImageToPhotosAlbum.html
 */
export function saveImageToPhotosAlbum(opts) {
	return invokeAPI('saveImageToPhotosAlbum', opts)
}

/**
 * 在新页面中全屏预览图片
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.previewImage.html
 */
export function previewImage(opts) {
	return invokeAPI('previewImage', opts)
}

/**
 * 压缩图片接口，可选压缩质量。
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.compressImage.html
 */
export function compressImage(opts) {
	return invokeAPI('compressImage', opts)
}

/**
 * 从本地相册选择图片或使用相机拍照。
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseImage.html
 */
export function chooseImage(opts) {
	return invokeAPI('chooseImage', opts)
}
