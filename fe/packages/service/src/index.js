import { callback, uuid } from '@dimina/common'
import { navigateBack, navigateTo, redirectTo, reLaunch, switchTab } from './api/core/route'
import env from './core/env'
import hostEnv from './core/host-env'
import loader from './core/loader'
import message from './core/message'
import runtime from './core/runtime'

const actionMap = { navigateBack, navigateTo, reLaunch, redirectTo, switchTab }

/**
 * 逻辑层消息通道
 */
class Service {
	constructor() {
		console.log('[service] init')
		this.env = env
		this.message = message
		this.init()
	}

	init() {
		this.message.on('loadResource', (msg) => {
			const { appId, bridgeId, pagePath, root = '.', baseUrl = '/', hostEnv: hostEnvSnapshot } = msg
			if (hostEnvSnapshot) {
				hostEnv.init(hostEnvSnapshot)
			}
			loader.loadResource({ appId, bridgeId, pagePath, root, baseUrl })
		})

		// 来自 components/events.js
		this.message.on('t', async (msg) => {
			const { bridgeId, moduleId, methodName, event, success } = msg
			if (methodName === undefined) {
				return
			}
			const data = await runtime.triggerEvent({ bridgeId, moduleId, methodName, event })
			// 如果自定义事件有返回值，则将逻辑层执行结果透传给渲染层
			if (data !== undefined) {
				this.message.send({
					type: 'triggerCallback',
					target: 'render',
					body: {
						bridgeId,
						moduleId,
						success,
						data,
					},
				})
			}
		})

		this.message.on('triggerCallback', (msg) => {
			const { id, args } = msg
			callback.invoke(id, args)
		})

		this.onAppMsg()
		this.onModuleMsg()
	}

	onAppMsg() {
		// 创建 app 实例
		this.message.on('resourceLoaded', (msg) => {
			const { bridgeId, scene, pagePath, query, stackId } = msg
			runtime.createApp({ scene, pagePath, query })

			const module = loader.getModuleByPath(pagePath)
			if (!module) {
				console.error(`[service] resourceLoaded: module not found, pagePath: ${pagePath}`)
				return
			}
			const initialProps = loader.getPropsByPath(module.usingComponents)

			const pageId = `page_${uuid()}`
			// 创建页面实例
			runtime.createInstance({ bridgeId, moduleId: pageId, path: pagePath, query, stackId })

			message.send({
				type: 'firstRender',
				target: 'render',
				body: {
					bridgeId,
					pageId,
					pagePath,
					initialProps,
					query,
				},
			})
		})

		this.message.on('appShow', () => {
			runtime.appShow()
		})

		this.message.on('appHide', () => {
			runtime.appHide()
		})

		this.message.on('stackShow', ({ stackId }) => {
			runtime.stackShow(stackId)
		})

		this.message.on('stackHide', ({ stackId }) => {
			runtime.stackHide(stackId)
		})
	}

	/**
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/page-life-cycle.html
	 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/lifetimes.html
	 */
	onModuleMsg() {
		this.message.on('mC', (msg) => {
			// 创建逻辑层组件实例映射
			runtime.createInstance(msg)
		})

		this.message.on('mR', (msg) => {
			// 在组件在视图层布局完成后执行
			runtime.moduleReady(msg)
		})

		this.message.on('mU', (msg) => {
			// 实例销毁
			runtime.moduleUnmounted(msg)
		})

		this.message.on('pageUnload', (msg) => {
			// 页面销毁时执行
			runtime.pageUnload(msg)
		})

		this.message.on('pageShow', (msg) => {
			// 页面出现在前台时执行
			runtime.pageShow(msg)
		})

		this.message.on('pageReady', (msg) => {
			// 页面首次渲染完毕时执行
			runtime.pageReady(msg)
		})

		this.message.on('pageHide', (msg) => {
			// 页面从前台变为后台时执行
			runtime.pageHide(msg)
		})

		this.message.on('pagePullDownRefresh', () => {
			// TODO:触发下拉刷新时执行
		})

		this.message.on('pageReachBottom', () => {
			// TODO:页面触底时执行
		})

		this.message.on('pageShareAppMessage', () => {
			// TODO:页面被用户分享时执行
		})

		this.message.on('pageScroll', (msg) => {
			// 页面滚动时执行
			runtime.pageScroll(msg)
		})

		this.message.on('pageResize', (msg) => {
			// 页面尺寸变化时执行
			runtime.pageResize(msg)

			// TODO: 调用组件 pageLifetimes.resize
		})

		this.message.on('onTabItemTap', () => {
			// TODO:tab 点击时执行
			// console.log(item.index)
			// console.log(item.pagePath)
			// console.log(item.text)
		})

		// 组件所在页面路由动画完成时执行
		this.message.on('pageRouteDone', (msg) => {
			const { bridgeId } = msg

			// TODO: 调用组件 pageLifetimes.routeDone
			runtime.componentRouteDone({ bridgeId })
		})

		this.message.on('componentError', (msg) => {
			// 每当组件方法抛出错误时执行
			runtime.componentError(msg)
		})

		this.message.on('h5SdkAction', async (msg = {}) => {
			const actionName = msg?.name?.replace(/h5/i, '')
			const { url } = msg?.params?.data?.params || {}

			msg.params && (msg.params.data = {
				...msg.params?.data,
				...msg.params?.data?.params || {},
			})

			// postMessage 需要单独处理
			if (actionName === 'postMessage' && msg.parentWebViewId) {
				const { moduleId, attrs, params } = msg
				// todo 网页向小程序 postMessage 时，会在以下特定时机触发并收到消息：小程序后退、组件销毁、分享、复制链接（2.31.1）。e.detail = { data }，data是多次 postMessage 的参数组成的数组。
				// https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html#%E5%B1%9E%E6%80%A7%E8%AF%B4%E6%98%8E
				const event = { detail: { data: [params?.data?.params?.data] } }
				const methodName = attrs.message
				const parentWebViewId = msg.parentWebViewId

				const data = await runtime.triggerEvent({ bridgeId: parentWebViewId, moduleId, methodName, event })

				if (data !== undefined) {
					this.message.send({
						type: 'triggerCallback',
						target: 'service',
						body: {
							bridgeId: parentWebViewId,
							moduleId,
							success: params?.success,
							data,
						},
					})
				}
			}

			actionMap[actionName]?.({ url, ...msg.params })
		})
	}
}

export default new Service()
