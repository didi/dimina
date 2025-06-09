import { invokeAPI } from '@/api/common'

/**
 * 获取菜单按钮（右上角胶囊按钮）的布局位置信息。坐标信息以屏幕左上角为原点。
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/menu/wx.getMenuButtonBoundingClientRect.html
 */
export function getMenuButtonBoundingClientRect() {
	if (globalThis.injectInfo) {
		return globalThis.injectInfo.menuRect
	}
	return invokeAPI('getMenuButtonBoundingClientRect')
}
