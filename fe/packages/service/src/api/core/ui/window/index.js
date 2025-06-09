import { invokeAPI } from '@/api/common'

/**
 * 监听窗口尺寸变化事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/window/wx.onWindowResize.html
 */
export function onWindowResize(listener) {
	if (listener) {
		invokeAPI('onWindowResize', {
			success: listener,
		})
	}
}
