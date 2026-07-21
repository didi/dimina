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
		if (this.destroyed) {
			return
		}
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
		if (this.destroyed) {
			return
		}
		// 如果浏览器开启了移动设备模式，被误识别为 android/ios，需要手动转换字符串对象
		if (typeof msg === 'string') {
			msg = JSON.parse(msg)
		}
		const { type, body, target } = msg

		// 按 id 过滤不同的 bridge 事件
		if (body.bridgeId && body.bridgeId !== this.id) {
			return
		}
		if (body.resourceLoadId && body.resourceLoadId !== this.resourceLoadId) {
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
				if (this.isResourceLoaded() && !this.resourceLoadedForwarded) {
					this.resourceLoadedForwarded = true
					transMsg.type = 'resourceLoaded'
				}
				else {
					return
				}
			}
			else if (type === 'renderResourceLoaded') {
				this.renderResource = true
				if (this.isResourceLoaded() && !this.resourceLoadedForwarded) {
					this.resourceLoadedForwarded = true
					transMsg.type = 'resourceLoaded'
				}
				else {
					return
				}
			}
			else if (type === 'renderResourceLoadFailed') {
				this.renderResource = false
				this.resourceLoadedForwarded = false
				transMsg.type = 'resourceLoadFailed'
			}
			this.jscore.postMessage(transMsg)
			if (transMsg.type === 'resourceLoaded') {
				this.#flushPageVisibility()
			}
		}
		else if (target === 'container') {
			if (type === 'invokeAPI') {
				const { name, params } = body
				// parent 是 miniApp 对象；带上调用方 bridge，让 hideHomeButton 这类
				// 作用于"调用页自身"的 API 能定位到正确的页面
				this.parent.invokeApi(name, params, this)
			}
		}
	}

	/**
	 * 启动资源加载
	 */
	start(options = {}) {
		this.resourceLoadId = uuid()
		if (Object.prototype.hasOwnProperty.call(options, 'visible')) {
			this.desiredPageVisible = options.visible
		}
		else if (this.desiredPageVisible === null) {
			this.desiredPageVisible = true
		}

		// 通知渲染线程加载资源
		this.webview.postMessage({
			type: 'loadResource',
			body: {
				bridgeId: this.id,
				resourceLoadId: this.resourceLoadId,
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
				resourceLoadId: this.resourceLoadId,
				appId: this.opts.appId,
				pagePath: this.opts.pagePath,
				scene: this.opts.scene,
				query: this.opts.query,
				root: this.opts.root,
				baseUrl: import.meta.env.BASE_URL,
				hostEnv: this.parent.getHostEnvSnapshot(),
			},
		})

		if (this.opts.isRoot) {
			this.jscore.postMessage({
				type: 'onUpdateStatusChange',
				body: {
					bridgeId: this.id,
					event: 'noupdate',
				},
			})
		}
	}

	resetStatus() {
		this.destroyed = false
		this.serviceResource = false
		this.renderResource = false
		this.resourceLoadedForwarded = false
		this.resourceLoadId = null
		this.desiredPageVisible = null
		this.sentPageVisible = null
	}

	createWebview() {
		return new Promise((resolve) => {
			const webview = new WebView({
				configInfo: this.opts.configInfo,
				isRoot: this.opts.isRoot,
				// 返回首页按钮显隐的权威判据在 miniApp（它掌握 entryPagePath / tabBar）
				showHomeButton: this.parent.shouldShowHomeButton({
					pagePath: this.opts.pagePath,
					configInfo: this.opts.configInfo,
					isRoot: this.opts.isRoot,
				}),
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
		this.desiredPageVisible = true
		this.#flushPageVisibility()
	}

	pageHide() {
		this.desiredPageVisible = false
		this.#flushPageVisibility()
	}

	#flushPageVisibility() {
		if (
			!this.isResourceLoaded()
			|| this.desiredPageVisible === null
			|| this.sentPageVisible === this.desiredPageVisible
		) {
			return
		}

		this.jscore.postMessage({
			type: this.desiredPageVisible ? 'pageShow' : 'pageHide',
			body: {
				bridgeId: this.id,
			},
		})
		this.sentPageVisible = this.desiredPageVisible
	}

	destroy() {
		const wasResourceLoaded = this.isResourceLoaded()
		this.destroyed = true
		this.serviceResource = false
		this.renderResource = false
		this.resourceLoadedForwarded = false
		this.resourceLoadId = null
		this.desiredPageVisible = null
		this.sentPageVisible = null
		if (wasResourceLoaded) {
			this.jscore.postMessage({
				type: 'pageUnload',
				body: {
					bridgeId: this.id,
				},
			})
		}
	}
}
