import { createContainer, QueryRouter } from '@dimina/fe-container-sdk'
import '@dimina/fe-container-sdk/style.css'
import { AppList } from '@/pages/appList/appList'
import { Device } from '@/pages/device/device'
import { getMiniAppInfo, manifestInfoCache, resolveManifestResourceBaseUrl } from '@/services'
import '@/styles/app.scss'

window.onload = function () {
	const device = new Device()
	const container = createContainer({
		mount: device.appContainer,
		shell: device, // Device 实现了 SDK 要求的 getStatusBarRect/updateStatusBarColor 接口
		getAppInfo: appId => manifestInfoCache.get(appId) ?? getMiniAppInfo(appId),
		// SDK 自身的默认值恒为 '/'（预构建 dist，感知不到宿主的部署路径）；这里必须显式传本包
		// 构建时的 BASE_URL（GitHub Pages 部署在 /dimina/ 子路径下，见 vite.config.mjs 的 base 配置），
		// 否则小程序资源与 pageFrame.html 都会从站点根路径请求，在子路径部署下 404。
		resourceBaseUrl: import.meta.env.BASE_URL,
	})
	device.open(container.application)

	/**
	 * 注册 Mock 第三方扩展模块，供 ext-bridge demo 页面使用。
	 * 宿主接入时用真实的 native bridge 实现替换此处的注册调用。
	 *
	 * handler 签名：({ event, data, success, fail }) => unsubscribeFn | void
	 * - 持续订阅（extOnBridge）：返回取消订阅函数
	 * - 一次性调用（extBridge）：调用 success/fail，无需返回值
	 */
	container.registerExtModule('DemoNativeModule', ({ event, data, success, fail }) => {
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

	/**
	 * SDK 不内置 wx.request 的网络请求实现（container-sdk 是通用运行时，不能假设宿主
	 * 一定有本地代理这类基础设施）；本 demo 配套 fe/packages/server 的开发态 CORS 代理，
	 * 在这里通过 registerApi 接上，行为与移除前完全一致。
	 */
	container.registerApi('request', function ({
		url,
		data,
		header = {},
		timeout = 0, // 0 表示不设超时
		method = 'GET',
		dataType = 'json',
		responseType = 'text',
		success,
		fail,
		complete,
	}) {
		const init = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				url,
				data,
				header,
				timeout,
				method,
				dataType,
				responseType,
			}),
		}

		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		fetch('http://localhost:7788/proxy', init)
			.then((response) => {
				if (!response.ok) {
					const error = new Error(response.statusText)
					error.code = response.status
					throw error
				}

				const headers = {}
				response.headers.forEach((value, key) => {
					headers[key] = value
				})

				switch (dataType) {
					case 'json':
						return response.json().then(data => ({ data: JSON.parse(data), header: headers, statusCode: response.status }))
					case 'arraybuffer':
						return response.arrayBuffer().then(data => ({ data, header: headers, statusCode: response.status }))
					default:
						return response.text().then(data => ({ data, header: headers, statusCode: response.status }))
				}
			})
			.then((data) => {
				onSuccess?.(data)
			})
			.catch((error) => {
				onFail?.({ errMsg: error.message, errno: error.code })
			})
			.finally(() => {
				onComplete?.()
			})
	})

	const appListPage = new AppList(container)
	container.setRootView(appListPage)

	const searchParams = new URLSearchParams(window.location.search)
	const manifestUrl = searchParams.get('manifestUrl')
	if (manifestUrl) {
		resolveManifestResourceBaseUrl(null, manifestUrl)
			.then(manifest => container.openApp({
				appId: manifest.appId,
				path: searchParams.get('entry') || manifest.path,
				resourceBaseUrl: manifest.resourceBaseUrl,
				scene: 1001,
				destroy: true,
			}))
			.catch((error) => {
				console.error('[container] open from manifestUrl failed:', error)
			})
		return
	}

	// 刷新后从 query 路由恢复小程序及页面；兼容旧 hash 路由
	const parsed = QueryRouter.parse(window.location.hash, window.location.search)
	if (parsed) {
		resolveManifestResourceBaseUrl(parsed.appId, null)
			.then(manifest => container.openApp({
				appId: parsed.appId,
				resourceBaseUrl: manifest?.resourceBaseUrl,
				scene: 1001,
				destroy: true,
				// 省略 path：入口页取 restoreStack[0]（pagePath + query）；完整栈用于静默恢复二级页面
				restoreStack: parsed.stack,
			}))
			.catch((error) => {
				// URL 是用户可改的输入（appId 可能无效，manifest 可能取不到），失败不能只剩 unhandled rejection
				console.error('[container] restore openApp failed:', error)
			})
	}
}
