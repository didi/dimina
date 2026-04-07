import { AppManager } from '@/core/appManager'
import { Application } from '@/pages/application/application'
import { AppList } from '@/pages/appList/appList'
import { Device } from '@/pages/device/device'
import { HashRouter } from '@/utils/hashRouter'
import '@/styles/app.scss'

/**
 * 注册 Mock 第三方扩展模块，供 ext-bridge demo 页面使用。
 * 宿主接入时用真实的 native bridge 实现替换此处的注册调用。
 *
 * handler 签名：({ event, data, success, fail }) => unsubscribeFn | void
 * - 持续订阅（extOnBridge）：返回取消订阅函数
 * - 一次性调用（extBridge）：调用 success/fail，无需返回值
 */
AppManager.registerExtModule('DemoNativeModule', ({ event, data, success, fail }) => {
	if (event === 'getUserInfo') {
		setTimeout(() => {
			success?.({ uid: data?.uid ?? 'unknown', name: 'Mock User', level: 3 })
		}, 300)
		return
	}

	if (event === 'onTickEvent') {
		let count = 0
		const timer = setInterval(() => {
			count++
			success?.({ tick: count, timestamp: Date.now() })
		}, 1000)
		return () => clearInterval(timer)
	}

	fail?.({ errMsg: `DemoNativeModule: unknown event "${event}"` })
})

window.onload = function () {
	const device = new Device()
	const application = new Application()
	const appListPage = new AppList()
	application.initRootView(appListPage)
	device.open(application)

	// 刷新后从 hash 恢复小程序及完整页面栈
	const parsed = HashRouter.parse(window.location.hash)
	if (parsed) {
		const rootPage = parsed.stack[0]
		// path 格式为 pagePath?query，queryPath 会统一处理
		const rootPath = rootPage.query && Object.keys(rootPage.query).length > 0
			? `${rootPage.pagePath}?${Object.entries(rootPage.query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
			: rootPage.pagePath
		AppManager.openApp({
			appId: parsed.appId,
			path: rootPath,
			scene: 1001,
			destroy: true,
			restoreStack: parsed.stack, // 完整栈，用于静默恢复二级页面
		}, application)
	}
}
