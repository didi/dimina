import type { JSCore } from './jscore.js'
import type { MiniApp } from '../pages/miniApp/miniApp.js'
import type { BridgeMessage, BridgeOptions } from '../types.js'
import chalk from 'chalk'
import { WebView } from '../pages/webview/webview.js'
import { uuid } from '../utils/util.js'

const RESOURCE_READY_TIMEOUT_MS = 15000

/** Bridge.start(options) 的可选启动参数：透传 visible 覆盖 desiredPageVisible 缺省值。 */
export interface BridgeStartOptions {
	visible?: boolean
}

export class Bridge {
	id: string
	opts: BridgeOptions & { jscore: JSCore }
	webview: WebView | null
	jscore: JSCore
	parent: MiniApp | null
	destroyed!: boolean
	serviceResource!: boolean
	renderResource!: boolean
	resourceLoadedForwarded!: boolean
	resourceLoadId!: string | null
	desiredPageVisible!: boolean | null
	sentPageVisible!: boolean | null
	private resourceReadyWaiter: {
		resourceLoadId: string
		resolve: () => void
		reject: (error: Error) => void
		timer: ReturnType<typeof setTimeout>
		unsubscribeWorkerFailure: () => void
	} | null

	constructor(opts: BridgeOptions & { jscore: JSCore }) {
		this.id = `bridge_${uuid()}`
		this.opts = opts
		this.webview = null
		this.jscore = opts.jscore
		this.parent = null
		this.resourceReadyWaiter = null
		this.resetStatus()
	}

	async init(signal?: AbortSignal): Promise<void> {
		this.webview = await this.createWebview(signal)
		// 握手完成前被 abort：安静退出，不算错误。jscore 监听器必须在这之后才注册，
		// 否则被丢弃的 Bridge 会经残留监听器泄漏（worker 在 start() 之前不知道
		// 这个 bridgeId，延后注册不会丢消息）。
		if (!this.webview) {
			return
		}
		this.jscore.invoke(msg => this.messageInvoke('service', msg))
		this.jscore.publish(msg => this.messagePublish(msg))
		this.webview.invoke(msg => this.messageInvoke('render', msg))
		this.webview.publish(msg => this.messagePublish(msg))
	}

	/**
	 * 消息中转
	 * @param {*} msg
	 */
	messagePublish(msg: BridgeMessage | string): void {
		if (this.destroyed) {
			return
		}
		if (typeof msg === 'string') {
			msg = JSON.parse(msg) as BridgeMessage
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
			this.webview!.postMessage(msg)
		}
	}

	/**
	 * 消息处理
	 * @param {*} source
	 * @param {*} msg
	 */
	messageInvoke(source: 'service' | 'render', msg: BridgeMessage | string): void {
		if (this.destroyed) {
			return
		}
		// 如果浏览器开启了移动设备模式，被误识别为 android/ios，需要手动转换字符串对象
		if (typeof msg === 'string') {
			msg = JSON.parse(msg) as BridgeMessage
		}
		const { type, body, target } = msg

		// 按 id 过滤不同的 bridge 事件
		if (body.bridgeId && body.bridgeId !== this.id) {
			return
		}
		const isResourceLifecycleMessage = type === 'serviceResourceLoaded'
			|| type === 'renderResourceLoaded'
			|| type === 'renderResourceLoadFailed'
		if (
			isResourceLifecycleMessage
			&& (
				typeof body.resourceLoadId !== 'string'
				|| body.resourceLoadId !== this.resourceLoadId
			)
		) {
			return
		}
		if (!isResourceLifecycleMessage && body.resourceLoadId && body.resourceLoadId !== this.resourceLoadId) {
			return
		}

		console.log(chalk.green(`[container] receive msg from ${source}: `), msg)

		const transMsg: BridgeMessage = {
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
				// service 侧 runtime 处理完第一次 loadResource 即完成 App 实例
				// 构造，此后 app 级 appShow/appHide 才真正有意义——通知 jscore
				// 补发累积期间的期望可见性（幂等，仅首次真正生效）。
				this.jscore.notifyServiceReady()
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
				this.#resolveResourceReady()
			}
			else if (transMsg.type === 'resourceLoadFailed') {
				const errors = Array.isArray(body.errors) ? body.errors.map(String).join('; ') : ''
				this.#rejectResourceReady(new Error(errors || `render resource load failed: ${this.opts.pagePath}`))
			}
		}
		else if (target === 'container') {
			if (type === 'invokeAPI') {
				const { name, params } = body as { name: string, params?: Record<string, unknown> }
				// parent 是 miniApp 对象；带上调用方 bridge，让 hideHomeButton 这类
				// 作用于"调用页自身"的 API 能定位到正确的页面
				this.parent!.invokeApi(name, params, this)
			}
		}
	}

	/**
	 * 启动资源加载
	 */
	start(options: BridgeStartOptions = {}): void {
		this.#rejectResourceReady(new Error('resource load was superseded'))
		this.resourceLoadId = uuid()
		if (Object.prototype.hasOwnProperty.call(options, 'visible')) {
			this.desiredPageVisible = options.visible ?? null
		}
		else if (this.desiredPageVisible === null) {
			this.desiredPageVisible = true
		}

		// 通知渲染线程加载资源
		this.webview!.postMessage({
			type: 'loadResource',
			body: {
				bridgeId: this.id,
				resourceLoadId: this.resourceLoadId,
				appId: this.opts.appId,
				runtimeType: this.opts.runtimeType,
				pagePath: this.opts.pagePath,
				root: this.opts.root,
				baseUrl: this.parent?.getResourceBaseUrl?.() ?? '/',
			},
		})

		// 通知逻辑线程加载资源
		this.jscore.postMessage({
			type: 'loadResource',
			body: {
				bridgeId: this.id,
				resourceLoadId: this.resourceLoadId,
				appId: this.opts.appId,
				runtimeType: this.opts.runtimeType,
				pagePath: this.opts.pagePath,
				scene: this.opts.scene,
				query: this.opts.query,
				referrerInfo: this.opts.referrerInfo,
				root: this.opts.root,
				baseUrl: this.parent?.getResourceBaseUrl?.() ?? '/',
				hostEnv: this.parent!.getHostEnvSnapshot(),
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

	/**
	 * 冷重启的事务门：只有 service 与 render 都回报当次 resourceLoadId
	 * 就绪才提交。Worker 失败、渲染资源失败或超时都 reject，让 Application
	 * 恢复旧 runtime，不会先回调 ok 再留下空实例。
	 */
	startAndWait(options: BridgeStartOptions = {}): Promise<void> {
		this.start(options)
		if (this.isResourceLoaded()) {
			return Promise.resolve()
		}
		const expectedResourceLoadId = this.resourceLoadId
		if (!expectedResourceLoadId) {
			return Promise.reject(new Error('resource load did not start'))
		}
		return new Promise((resolve, reject) => {
			const unsubscribeWorkerFailure = this.jscore.onWorkerFailure((reason) => {
				const detail = reason instanceof Error ? reason.message : 'worker failed while loading resources'
				this.#rejectResourceReady(new Error(detail))
			})
			const timer = setTimeout(() => {
				this.#rejectResourceReady(new Error(`resource load timed out: ${this.opts.pagePath}`))
			}, RESOURCE_READY_TIMEOUT_MS)
			this.resourceReadyWaiter = {
				resourceLoadId: expectedResourceLoadId,
				resolve,
				reject,
				timer,
				unsubscribeWorkerFailure,
			}
			// 保护测试替身或宿主桥接同步回包的非标准情形。
			this.#resolveResourceReady()
		})
	}

	#resolveResourceReady(): void {
		const waiter = this.resourceReadyWaiter
		if (
			!waiter
			|| waiter.resourceLoadId !== this.resourceLoadId
			|| !this.isResourceLoaded()
		) {
			return
		}
		this.resourceReadyWaiter = null
		clearTimeout(waiter.timer)
		waiter.unsubscribeWorkerFailure()
		waiter.resolve()
	}

	#rejectResourceReady(error: Error): void {
		const waiter = this.resourceReadyWaiter
		if (!waiter) {
			return
		}
		this.resourceReadyWaiter = null
		clearTimeout(waiter.timer)
		waiter.unsubscribeWorkerFailure()
		waiter.reject(error)
	}

	resetStatus(): void {
		this.#rejectResourceReady(new Error('resource load state was reset'))
		this.destroyed = false
		this.serviceResource = false
		this.renderResource = false
		this.resourceLoadedForwarded = false
		this.resourceLoadId = null
		this.desiredPageVisible = null
		this.sentPageVisible = null
	}

	/**
	 * 被 abort 时 resolve(null) 而非 reject，调用方据此静默放弃；挂载后才 abort 的
	 * 会摘除已插入的 el，不留孤儿 iframe。非 abort 的真实初始化失败照常 reject。
	 */
	createWebview(signal?: AbortSignal): Promise<WebView | null> {
		if (signal?.aborted) {
			return Promise.resolve(null)
		}
		return new Promise((resolve, reject) => {
			const webview = new WebView({
				configInfo: this.opts.configInfo,
				isRoot: this.opts.isRoot,
				pageFrameUrl: this.parent?.getPageFrameUrl?.(),
				resourceBaseUrl: this.parent?.getResourceBaseUrl?.(),
				// 返回首页按钮显隐的权威判据在 miniApp（它掌握 entryPagePath / tabBar）
				showHomeButton: this.parent?.shouldShowHomeButton?.({
					pagePath: this.opts.pagePath,
					configInfo: this.opts.configInfo,
					isRoot: this.opts.isRoot,
				}) ?? false,
			})

			webview.parent = this
			if (!this.opts.isRoot) {
				webview.el.classList.add('dimina-native-view--before-enter')
			}
			this.parent!.webviewsContainer!.appendChild(webview.el)
			webview.init(() => {
				resolve(webview)
			}, signal).catch((error: unknown) => {
				webview.el.remove()
				// 按 name 而不是 instanceof DOMException 判定：signal.reason 来自
				// AbortController 所在 realm，跨 realm 时 instanceof 会失效。
				if ((error as { name?: string } | null)?.name === 'AbortError') {
					resolve(null)
					return
				}
				reject(error)
			})
		})
	}

	/**
	 * 双线程资源是否已经初始化完成
	 */
	isResourceLoaded(): boolean {
		return this.serviceResource && this.renderResource
	}

	pageShow(): void {
		this.desiredPageVisible = true
		this.#flushPageVisibility()
	}

	pageHide(): void {
		this.desiredPageVisible = false
		this.#flushPageVisibility()
	}

	#flushPageVisibility(): void {
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

	destroy(): void {
		const wasResourceLoaded = this.isResourceLoaded()
		this.#rejectResourceReady(new Error('bridge was destroyed before resources became ready'))
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
