import { invokeAPI } from '@/api/common'

export { createVideoDecoder } from './video-decoder'

export function createVideoContext(videoId, obj) {
	return new VideoContext({ videoId, obj })
}

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

/** 获取视频信息。 */
export function getVideoInfo(opts) {
	return invokeAPI('getVideoInfo', opts)
}

/** 保存视频到系统相册。 */
export function saveVideoToPhotosAlbum(opts) {
	return invokeAPI('saveVideoToPhotosAlbum', opts)
}

/** 压缩视频。 */
export function compressVideo(opts) {
	return invokeAPI('compressVideo', opts)
}

class VideoContext {
	constructor(opts) {
		this.opts = opts
	}

	play() {
		this.invoke('play')
	}

	pause() {
		this.invoke('pause')
	}

	stop() {
		this.invoke('stop')
	}

	seek(position) {
		this.invoke('seek', { position })
	}

	playbackRate(rate) {
		this.invoke('playbackRate', { rate })
	}

	requestFullScreen(data = {}) {
		this.invoke('requestFullScreen', data)
	}

	exitFullScreen() {
		this.invoke('exitFullScreen')
	}

	requestBackgroundPlayback(data = {}) {
		this.invoke('requestBackgroundPlayback', data)
	}

	exitBackgroundPlayback() {
		this.invoke('exitBackgroundPlayback')
	}

	exitPictureInPicture(data = {}) {
		this.invoke('exitPictureInPicture', data)
	}

	showStatusBar() {
		this.invoke('showStatusBar')
	}

	hideStatusBar() {
		this.invoke('hideStatusBar')
	}

	invoke(command, data = {}) {
		invokeAPI('videoContext', {
			type: 'native/video',
			id: this.opts.videoId,
			command,
			...data,
		}, 'render')
	}
}
