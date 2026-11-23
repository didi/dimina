import { invokeAPI } from '@/api/common'
import { reportAppError } from '@/core/app-events'
import message from '@/core/message'

const keyboardHeightListeners = new Set()
let lastHeight = 0

message.on('keyboardHeightChange', (body) => {
	const height = body?.height
	if (!Number.isFinite(height) || height < 0 || height === lastHeight) return
	lastHeight = height
	for (const listener of [...keyboardHeightListeners]) {
		try {
			listener({ height })
		}
		catch (error) {
			reportAppError(error)
		}
	}
})

/** 监听小程序内软键盘高度变化。 */
export function onKeyboardHeightChange(listener) {
	if (typeof listener === 'function') keyboardHeightListeners.add(listener)
}

/** 移除指定的监听函数，省略参数时移除全部监听。 */
export function offKeyboardHeightChange(listener) {
	if (listener === undefined) keyboardHeightListeners.clear()
	else keyboardHeightListeners.delete(listener)
}

/**
 * 在input、textarea等focus拉起键盘之后，手动调用此接口收起键盘
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/keyboard/wx.hideKeyboard.html
 */
export function hideKeyboard(opts) {
	return invokeAPI('hideKeyboard', opts)
}
