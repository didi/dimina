import { callback } from '@dimina/common'
import env from './core/env'
import loader from './core/loader'
import message from './core/message'
import runtime from './core/runtime'

/**
 * 渲染层消息通道
 */
class Render {
	constructor() {
		console.log('[system]', '[render]', 'init')
		this.env = env
		this.message = message
		window.__message = message
		window.__callback = callback

		this.init()
	}

	init() {
		// 资源加载消息
		this.message.on('loadResource', (msg) => {
			const { bridgeId, appId, pagePath, root = '.', baseUrl = '/' } = msg
			loader.loadResource({ bridgeId, appId, pagePath, root, baseUrl })
		})

		// 数据初始化消息
		this.message.on('firstRender', (msg) => {
			const { bridgeId, pageId, pagePath, initialProps, query } = msg

			loader.setInitialData(initialProps)
			runtime.firstRender({
				pagePath,
				pageId,
				bridgeId,
				query,
			})
		})

		this.message.on('u', (msg) => {
			queueMicrotask(() => {
				runtime.updateModule(msg)
			})
		})

		this.message.on('invokeAPI', (msg) => {
			runtime[msg.name](msg)
		})

		this.message.on('triggerCallback', (msg) => {
			const { success, data } = msg
			success && callback.invoke(success, data)
		})

		if (__DEV__) {
			// 可接收端容器或引擎日志
			this.message.on('print', (msg) => {
				const { type, detail } = msg
				// eslint-disable-next-line no-console
				const logMethod = console[type] || console.log

				// Handle when detail is an object or a string representation of an object
				let parsedDetail = detail

				// Try to parse detail if it's a string that might be a JSON object
				if (typeof detail === 'string') {
					try {
						// Check if the string looks like an object (starts with '{')
						if (detail.trim().startsWith('{')) {
							parsedDetail = JSON.parse(detail)
						}
					}
					catch {
						// If parsing fails, keep the original string
						parsedDetail = detail
					}
				}

				if (typeof parsedDetail === 'object' && parsedDetail !== null) {
					const { group, value } = parsedDetail
					if (group === 'network' && window.vConsole) {
						window.vConsole.network.add(value)
					}
					else {
						logMethod('[system]', parsedDetail)
					}
				}
				else if (typeof detail === 'string' && detail.startsWith('[service]')) {
					logMethod('[system]', detail)
				}
				else {
					logMethod(detail)
				}
			})
		}
	}
}

export default new Render()
