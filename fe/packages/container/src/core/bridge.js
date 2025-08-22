import chalk from 'chalk'
import { WebView } from '@/pages/webview/webview'
import { uuid } from '@/utils/util'

export class Bridge {
	constructor(opts) {
		this.id = `bridge_${uuid()}`
		this.opts = opts
		this.webview = null
		this.jscore = opts.jscore
		this.parent = null
		this.resetStatus()
	}

	async init() {
		this.jscore.invoke(msg => this.messageInvoke('service', msg))
		this.jscore.publish(msg => this.messagePublish(msg))

		this.webview = await this.createWebview()
		this.webview.invoke(msg => this.messageInvoke('render', msg))
		this.webview.publish(msg => this.messagePublish(msg))
	}

	/**
	 * 消息中转
	 * @param {*} msg
	 */
	messagePublish(msg) {
		if (typeof msg === 'string') {
			msg = JSON.parse(msg)
		}
		const { body, target } = msg

		// 按 id 过滤不同的 bridge 事件
		if (body.bridgeId && body.bridgeId !== this.id) {
			return
		}

		if (target === 'service') {
			this.jscore.postMessage(msg)
		}
		else if (target === 'render') {
			this.webview.postMessage(msg)
		}
	}

	/**
	 * 消息处理
	 * @param {*} source
	 * @param {*} msg
	 */
	messageInvoke(source, msg) {
		// 如果浏览器开启了移动设备模式，被误识别为 android/ios，需要手动转换字符串对象
		if (typeof msg === 'string') {
			msg = JSON.parse(msg)
		}
		const { type, body, target } = msg

		// 按 id 过滤不同的 bridge 事件
		if (body.bridgeId && body.bridgeId !== this.id) {
			return
		}

		console.log(chalk.green(`[container] receive msg from ${source}: `), msg)

		const transMsg = {
			type,
			body: {
				bridgeId: this.id,
				pagePath: this.opts.pagePath,
				scene: this.opts.scene,
				query: this.opts.query,
				...body,
			},
		}

		if (target === 'service') {
			if (type === 'serviceResourceLoaded') {
				this.serviceResource = true
				if (this.isResourceLoaded()) {
					transMsg.type = 'resourceLoaded'
				}
				else {
					return
				}
			}
			else if (type === 'renderResourceLoaded') {
				this.renderResource = true
				if (this.isResourceLoaded()) {
					transMsg.type = 'resourceLoaded'
				}
				else {
					return
				}
			}
			this.jscore.postMessage(transMsg)
		}
		else if (target === 'container') {
			if (type === 'invokeAPI') {
				const { name, params } = body
				// parent 是 miniApp 对象
				this.parent[name]?.(params)
			}
		}
	}

	/**
	 * 启动资源加载
	 */
	start() {
		// 通知渲染线程加载资源
		this.webview.postMessage({
			type: 'loadResource',
			body: {
				bridgeId: this.id,
				appId: this.opts.appId,
				pagePath: this.opts.pagePath,
				root: this.opts.root,
				baseUrl: import.meta.env.BASE_URL,
			},
		})

		// 通知逻辑线程加载资源
		this.jscore.postMessage({
			type: 'loadResource',
			body: {
				bridgeId: this.id,
				appId: this.opts.appId,
				pagePath: this.opts.pagePath,
				root: this.opts.root,
				baseUrl: import.meta.env.BASE_URL,
				injectInfo: {
					// 注入同步 API 信息
					menuRect: this.parent.getMenuButtonBoundingClientRect(),
					systemInfo: this.parent.getSystemInfoSync(),
				},
			},
		})
	}

	resetStatus() {
		this.serviceResource = false
		this.renderResource = false
	}

	createWebview() {
		return new Promise((resolve) => {
			const webview = new WebView({
				configInfo: this.opts.configInfo,
				isRoot: this.opts.isRoot,
			})

			webview.parent = this
			webview.init(() => {
				resolve(webview)
			})
			if (!this.opts.isRoot) {
				webview.el.classList.add('dimina-native-view--before-enter')
			}
			this.parent.webviewsContainer.appendChild(webview.el)
		})
	}

	/**
	 * 双线程资源是否已经初始化完成
	 */
	isResourceLoaded() {
		return this.serviceResource && this.renderResource
	}

	appShow() {
		if (!this.isResourceLoaded()) {
			return
		}
		this.jscore.postMessage({
			type: 'appShow',
			body: {},
		})
	}

	appHide() {
		if (!this.isResourceLoaded()) {
			return
		}
		this.jscore.postMessage({
			type: 'appHide',
			body: {},
		})
	}

	pageShow() {
		if (!this.isResourceLoaded()) {
			return
		}
		this.jscore.postMessage({
			type: 'pageShow',
			body: {
				bridgeId: this.id,
			},
		})
	}

	pageHide() {
		if (!this.isResourceLoaded()) {
			return
		}
		this.jscore.postMessage({
			type: 'pageHide',
			body: {
				bridgeId: this.id,
			},
		})
	}

	destroy() {
		if (!this.isResourceLoaded()) {
			return
		}
		this.jscore.postMessage({
			type: 'pageUnload',
			body: {
				bridgeId: this.id,
			},
		})
	}
}
