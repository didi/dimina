import { invokeAPI } from '@/api/common'
import { isFunction } from '@dimina/common'
import hostEnv from '@/core/host-env'

const menuRectChangeCallbacks = new Set()

hostEnv.onUpdate((patch) => {
	if (!patch.menuRect) {
		return
	}
	menuRectChangeCallbacks.forEach(callback => callback(patch.menuRect))
})

/**
 * 获取菜单按钮（右上角胶囊按钮）的布局位置信息。坐标信息以屏幕左上角为原点。
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/menu/wx.getMenuButtonBoundingClientRect.html
 */
export function getMenuButtonBoundingClientRect() {
	return invokeAPI('getMenuButtonBoundingClientRect')
}

export function onMenuButtonBoundingClientRectWeightChange(callback) {
	if (isFunction(callback)) {
		menuRectChangeCallbacks.add(callback)
	}
}

export function offMenuButtonBoundingClientRectWeightChange(callback) {
	if (isFunction(callback)) {
		menuRectChangeCallbacks.delete(callback)
	}
	else {
		menuRectChangeCallbacks.clear()
	}
}
