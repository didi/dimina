import { invokeAPI } from '@/api/common'

// 显式列出 tabBar 系列 API 而不是依赖 Proxy 自动转发——因为 Taro 等桥接库会通过
// `Object.keys(wx)` 枚举可用 API 来构建 `Taro.xxx` 包装；Proxy 默认的 ownKeys
// 透传到 target（这里是 explicit api 集合），不显式声明的话 Taro 那侧拿不到这个名字，
// 用户调 `Taro.setTabBarStyle(...)` 时会拿到 undefined → "not a function"。

/**
 * 动态设置 tabBar 整体样式
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.setTabBarStyle.html
 */
export function setTabBarStyle(opts) {
	invokeAPI('setTabBarStyle', opts)
}

/**
 * 动态设置 tabBar 某一项的内容
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.setTabBarItem.html
 */
export function setTabBarItem(opts) {
	invokeAPI('setTabBarItem', opts)
}

/**
 * 显示 tabBar
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.showTabBar.html
 */
export function showTabBar(opts) {
	invokeAPI('showTabBar', opts)
}

/**
 * 隐藏 tabBar
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.hideTabBar.html
 */
export function hideTabBar(opts) {
	invokeAPI('hideTabBar', opts)
}

/**
 * 为 tabBar 某一项的右上角添加文本
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.setTabBarBadge.html
 */
export function setTabBarBadge(opts) {
	invokeAPI('setTabBarBadge', opts)
}

/**
 * 移除 tabBar 某一项右上角的文本
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.removeTabBarBadge.html
 */
export function removeTabBarBadge(opts) {
	invokeAPI('removeTabBarBadge', opts)
}

/**
 * 显示 tabBar 某一项右上角的红点
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.showTabBarRedDot.html
 */
export function showTabBarRedDot(opts) {
	invokeAPI('showTabBarRedDot', opts)
}

/**
 * 隐藏 tabBar 某一项右上角的红点
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.hideTabBarRedDot.html
 */
export function hideTabBarRedDot(opts) {
	invokeAPI('hideTabBarRedDot', opts)
}
