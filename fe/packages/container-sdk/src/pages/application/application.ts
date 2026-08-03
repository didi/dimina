import type { MiniApp } from '../miniApp/miniApp.js'
import type { ContainerView, GetAppInfo, OnAppLaunchError, ResolvedShell, ShellAdapter, StorageAdapter, UrlSyncAdapter } from '../../types.js'
import { WAIT_TRANSITION_TIMEOUT_MS } from '../../constants/animation.js'
import { resolveApiNamespaces, resolveGetAppInfo, resolvePageFrameUrl, resolveResourceBaseUrl, resolveShell, resolveStorageAdapter, resolveUrlSync } from '../../config.js'
import { AppManager } from '../../core/appManager.js'
import './application.scss'

// 等待下一帧，确保 class 变化触发浏览器重新计算样式后再启动 transition
const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

// 等待元素上指定 transition property 结束，带超时兜底防止动画未触发时永久阻塞
const waitTransitionEnd = (el: HTMLElement, property: string, timeout = WAIT_TRANSITION_TIMEOUT_MS): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, timeout)
		const handler = (e: TransitionEvent) => {
			if (!property || e.propertyName === property) {
				clearTimeout(timer)
				el.removeEventListener('transitionend', handler)
				resolve()
			}
		}
		el.addEventListener('transitionend', handler)
	})

export interface ApplicationOptions {
	/** 宿主 shell 适配器（状态栏几何/颜色），缺省安全降级 */
	shell?: ShellAdapter
	/** 小程序资源基路径，缺省 '/' */
	resourceBaseUrl?: string
	/** 渲染层 iframe URL，缺省基于 resourceBaseUrl 拼接 */
	pageFrameUrl?: string
	/** resourceBaseUrl/pageFrameUrl 最终解析出的 origin 白名单；不传则不限制来源 */
	allowedOrigins?: readonly string[]
	/** 额外 API 命名空间，缺省空数组 */
	apiNamespaces?: string[]
	/** 地址栏路由同步；缺省 true 沿用内置 QueryRouter，传 false 关闭，传适配器接管 */
	urlSync?: boolean | UrlSyncAdapter
	/** 多容器场景下给内置 QueryRouter 的地址栏 query key 命名空间化的稳定身份 key；不传行为不变 */
	instanceKey?: string
	/** wx 存储 API 落地位置；缺省 true 沿用内置 window.localStorage，传 false 关闭，传适配器接管 */
	storageSync?: boolean | StorageAdapter
	/** 小程序元信息提供者，缺省返回 {} */
	getAppInfo?: GetAppInfo
	/** 小程序启动失败通知；缺省不通知（仅内部 console.error） */
	onAppLaunchError?: OnAppLaunchError
	/** 该容器私有的应用管理器；缺省新建一个（自带隔离，不共享任何模块级状态） */
	appManager?: AppManager
}

export interface DismissViewOptions {
	/** 关闭时是否销毁小程序容器 */
	destroy?: boolean
}

export class Application {
	el!: HTMLElement
	window!: HTMLElement
	root: ContainerView | null
	views: MiniApp[]
	rootView: ContainerView | null
	/** 目前始终为 null：Application 是容器视图树的根，没有更上层的宿主对象需要回指。 */
	parent: unknown
	done: boolean
	isSleeping: boolean
	_queue: Promise<void>
	shell: ResolvedShell
	resourceBaseUrl: string
	pageFrameUrl: string
	/** resourceBaseUrl/pageFrameUrl 的 origin 白名单；openApp() 逐 app 覆盖 resourceBaseUrl 时复用同一份校验。 */
	allowedOrigins?: readonly string[]
	apiNamespaces: string[]
	urlSync: UrlSyncAdapter
	storageAdapter: StorageAdapter
	getAppInfo: GetAppInfo
	/** 小程序启动失败通知（可选）；MiniApp 经 this.parent 访问并在 initApp 失败时调用。 */
	onAppLaunchError?: OnAppLaunchError
	appManager: AppManager

	constructor(opts: ApplicationOptions = {}) {
		this.root = null
		this.views = []
		this.rootView = null
		this.parent = null
		this.done = true
		this.isSleeping = false
		this._queue = Promise.resolve() // 操作队列，保证动画串行
		this.shell = resolveShell(opts.shell)
		this.resourceBaseUrl = resolveResourceBaseUrl(opts.resourceBaseUrl, opts.allowedOrigins)
		this.pageFrameUrl = resolvePageFrameUrl(opts.pageFrameUrl, this.resourceBaseUrl, opts.allowedOrigins)
		this.allowedOrigins = opts.allowedOrigins
		this.apiNamespaces = resolveApiNamespaces(opts.apiNamespaces)
		this.urlSync = resolveUrlSync(opts.urlSync, opts.instanceKey)
		this.storageAdapter = resolveStorageAdapter(opts.storageSync)
		this.getAppInfo = resolveGetAppInfo(opts.getAppInfo)
		this.onAppLaunchError = opts.onAppLaunchError
		this.appManager = opts.appManager ?? new AppManager()
		this.init()
	}

	// 队列执行器，确保操作串行；队列尾部永不 reject，单次调用失败不阻塞后续操作
	_enqueue(fn: () => Promise<void>): Promise<void> {
		const result = this._queue.then(() => fn())
		this._queue = result.catch(() => {})
		return result
	}

	/**
	 * 地址栏路由同步的唯一权威调用点：只读当前展示栈栈顶实例的页面栈来回写地址栏，
	 * 栈空则清空。MiniApp 自身导航、Application 呈现/摘除展示栈都改为调用这里
	 * （而不是各自直接碰 urlSync），保证地址栏任何时刻都精确反映"当前可见的是谁"，
	 * 不会被非栈顶实例的内部状态变化覆盖。
	 */
	syncUrl(): void {
		const top = this.views[this.views.length - 1]
		if (!top) {
			this.urlSync.clear()
			return
		}
		this.urlSync.syncStack(top.appId, top.getPageStack())
	}

	/**
	 * 地址栏同步是尽力而为的旁路通知：宿主的 urlSync 适配器抛错，不能冒充"这次
	 * 呈现/摘除本身失败了"，也不能中断已经完成的转场——因此统一收窄异常。
	 */
	private safeSyncUrl(): void {
		try {
			this.syncUrl()
		}
		catch {
			// 见上方注释
		}
	}

	/**
	 * 配色恢复同理：宿主 shell.updateStatusBarColor 抛错不能挡住呈现流程的
	 * 其余提交工作，与 `safeSyncUrl()` 对 urlSync 适配器的处理保持同一契约——
	 * 完全吸收，不向调用方传播。
	 */
	private safeRestoreColorStyle(view: MiniApp): void {
		try {
			view.restoreColorStyle()
		}
		catch {
			// 见上方注释
		}
	}

	init(): void {
		this.el = document.createElement('div')
		this.el.classList.add('dimina-application')
		this.window = document.createElement('div')
		this.window.classList.add('dimina-native-window')
		this.el.appendChild(this.window)
	}

	initRootView(view: ContainerView): void {
		this.rootView = view
		view.parent = this
		view.el.classList.add('dimina-native-view--instage')
		view.el.style.zIndex = '1'
		this.root = view
		this.window.appendChild(view.el)
		view.viewDidLoad?.()
	}

	presentView(view: MiniApp, useCache: boolean): Promise<void> {
		return this._enqueue(() => this._presentView(view, useCache))
	}

	async _presentView(view: MiniApp, useCache: boolean): Promise<void> {
		if (!this.done) {
			return
		}

		if (this.views[this.views.length - 1] === view) {
			// 已经是栈顶：重复呈现同一个实例，跳过整套"退出/进入"转场——那套逻辑
			// 假设 preView 和 view 是两个不同实例，套在自己身上会产生自己对自己
			// 的假生命周期事件，并留下再也不会被移除的 --presenting 样式。
			// restoreColorStyle() 最终摸到的宿主 shell.updateStatusBarColor 与
			// urlSync 一样是宿主可控代码，抛错是一次 best-effort 旁路失败，
			// 完全吸收，不冒充"这次呈现本身失败了"。
			useCache && this.safeRestoreColorStyle(view)
			this.safeSyncUrl()
			return
		}

		this.done = false

		try {
			const preView = this.views[this.views.length - 1]
			view.parent = this
			view.el.style.zIndex = String(this.views.length + 1)
			view.el.classList.add('dimina-native-view--before-present')
			view.el.classList.add('dimina-native-view--enter-anima')
			preView?.el.classList.add('dimina-native-view--before-presenting')
			preView?.el.classList.remove('dimina-native-view--instage')
			preView?.el.classList.add('dimina-native-view--enter-anima')
			preView?.onPresentOut()
			// Application 处于 sleeping 状态时不能主动触发前台生命周期——
			// sleepActiveView() 只隐藏当前栈顶，不改变 views；这里若继续呈现新
			// 栈顶，应该等 wakeActiveView() 统一补发 onPresentIn()，不能抢先 fire
			// （与 removeFailedView 的同款门控保持一致）。
			if (this.isSleeping) {
				// 休眠期间新呈现的实例不能什么都不做：如果完全跳过，它的
				// app 级可见性期望会一直是"未设置"，而 service 侧构造 App 实例
				// 时天然会自动展示一次（对齐微信官方语义）。真正唤醒时
				// jscore 会因为查不到"之前隐藏过"的记录，误以为不需要再补发
				// 一次展示，导致小程序把这整段休眠期都当成前台在展示。这里
				// 显式调用 onPresentOut() 把期望状态设成隐藏——此时还没有任何
				// 页面 bridge，pageHide() 会安全地空操作，只有 appHide() 真正
				// 生效。
				view.onPresentOut()
			}
			else {
				view.onPresentIn()
			}
			!useCache && this.el.appendChild(view.el)
			const existingIndex = this.views.indexOf(view)
			if (existingIndex !== -1) {
				this.views.splice(existingIndex, 1)
			}
			this.views.push(view)
			!useCache && view.viewDidLoad && view.viewDidLoad()
			// 配色恢复最终摸到的宿主 shell.updateStatusBarColor 与 urlSync 一样是
			// 宿主可控代码，抛错是一次 best-effort 旁路失败，完全吸收，不挡住
			// 转场剩余的提交工作。
			useCache && this.safeRestoreColorStyle(view)

			await nextFrame()
			preView?.el.classList.add('dimina-native-view--presenting')
			view.el.classList.add('dimina-native-view--instage')
			await waitTransitionEnd(view.el, 'transform')
			view.el.classList.remove('dimina-native-view--before-present')
			view.el.classList.remove('dimina-native-view--enter-anima')
			preView?.el.classList.remove('dimina-native-view--enter-anima')
			preView?.el.classList.remove('dimina-native-view--before-presenting')

			this.safeSyncUrl()
		} finally {
			this.done = true
		}
	}

	dismissView(view: MiniApp, opts: DismissViewOptions = {}): Promise<void> {
		return this._enqueue(() => this._dismissView(view, opts))
	}

	async _dismissView(view: MiniApp, opts: DismissViewOptions = {}): Promise<void> {
		if (!this.done) {
			return
		}

		const index = this.views.indexOf(view)
		if (index === -1) {
			// 目标已不在展示栈中（例如已被其它路径关闭/销毁），空操作
			return
		}

		// 是否销毁指定容器
		const { destroy = true } = opts

		// 非栈顶实例当前不可见，没有退出动画可播：直接从展示栈摘除。
		// 摘除前必须清掉呈现态遗留的 class（如 --presenting 的 40px 圆角/缩放），
		// 否则 destroy:false 缓存复用时这些样式会残留到重新呈现的画面上。
		if (index !== this.views.length - 1) {
			this.views.splice(index, 1)
			view.el.classList.remove('dimina-native-view--presenting', 'dimina-native-view--before-presenting', 'dimina-native-view--enter-anima')
			if (destroy) {
				try {
					view.destroy()
				}
				catch (destroyError) {
					console.error(`[container] view.destroy() threw during dismissView cleanup for ${view.appId}:`, destroyError)
				}
				view.el.parentNode?.removeChild(view.el)
			}
			return
		}

		this.done = false

		try {
			const preView = this.views[this.views.length - 2]
			const currentView = view

			currentView.el.classList.add('dimina-native-view--enter-anima')
			preView?.el.classList.add('dimina-native-view--enter-anima')
			preView?.el.classList.add('dimina-native-view--before-presenting')
			await nextFrame()
			currentView.el.classList.add('dimina-native-view--before-present')
			currentView.el.classList.remove('dimina-native-view--instage')
			preView?.el.classList.remove('dimina-native-view--presenting')

			// 见 _presentView 里同款注释：sleeping 期间不能抢先 fire 前台生命周期，
			// 交给 wakeActiveView() 统一补发。
			if (!this.isSleeping) {
				preView?.onPresentIn()
			}
			currentView?.onPresentOut()

			await waitTransitionEnd(currentView.el, 'transform')

			if (destroy) {
				try {
					currentView.destroy()
				}
				catch (destroyError) {
					console.error(`[container] view.destroy() threw during dismissView cleanup for ${currentView.appId}:`, destroyError)
				}
				this.el.removeChild(currentView.el)
			}

			this.views.pop()
			preView?.el.classList.remove('dimina-native-view--enter-anima')
			preView?.el.classList.remove('dimina-native-view--before-presenting')

			this.safeSyncUrl()
		} finally {
			this.done = true
		}
	}

	async destroyRootView(view: MiniApp): Promise<void> {
		try {
			view.destroy()
		}
		catch (destroyError) {
			console.error(`[container] view.destroy() threw during destroyRootView for ${view.appId}:`, destroyError)
		}

		// 并发场景下该 view 可能还在排队、尚未被 presentView 推入 this.views，
		// indexOf 拿不到时直接跳过。
		const index = this.views.indexOf(view)
		if (index !== -1) {
			this.views.splice(index, 1)
		}

		// 父节点不能硬编码：presentView 挂在 this.el 下、initRootView 挂在
		// this.window 下，且并发排队时 view 可能尚未挂到任何父节点。
		view.el.parentNode?.removeChild(view.el)
	}

	/**
	 * 启动失败（MiniApp.initApp() 中途 reject）时的专用摘除：这个实例从未真正呈现
	 * 成功过，没有退出动画可播，直接按引用从展示栈里摘掉并清理 DOM。经同一条
	 * _enqueue 队列串行化，保证不会跟正在进行的 presentView/dismissView 并发碰撞
	 * this.views/DOM。
	 */
	removeFailedView(view: MiniApp): Promise<void> {
		return this._enqueue(async () => {
			const index = this.views.indexOf(view)
			const wasTop = index !== -1 && index === this.views.length - 1
			if (index !== -1) {
				this.views.splice(index, 1)
			}
			// DOM 清理不依赖是否还在 views 里——即使已经被更早排队的
			// dismissView(destroy:false) 缓存式摘除过（此时 views 里已经没有它，
			// 但 DOM 元素按设计保留用于复用），这个失败实例最终仍要被彻底丢弃，
			// 元素必须无条件摘除，不能因为"没在 views 里找到"就跳过 DOM 清理。
			view.el.parentNode?.removeChild(view.el)
			if (wasTop) {
				// 被摘除的失败实例原本是栈顶：它已经真实完成了一次呈现转场（否则
				// 不会进到"呈现之上又失败"这个场景），把新栈顶恢复回前台，避免
				// 画面停在一个空白/背景态上——语义与 _presentView 里旧 view 变为
				// 新栈顶时的状态完全一致。
				const newTop = this.views[this.views.length - 1]
				if (newTop) {
					newTop.el.classList.remove('dimina-native-view--presenting', 'dimina-native-view--before-presenting', 'dimina-native-view--enter-anima')
					newTop.el.classList.add('dimina-native-view--instage')
					this.safeRestoreColorStyle(newTop)
					// Application 处于 sleeping 状态时不能主动触发前台生命周期——
					// sleepActiveView() 只隐藏当前栈顶，不改变 views；被摘除的失败
					// 实例露出的新栈顶如果此刻仍在 sleeping，应该等 wakeActiveView()
					// 统一恢复，不能在这里抢先 fire。
					if (!this.isSleeping) {
						newTop.onPresentIn()
					}
				}
				this.safeSyncUrl()
			}
		})
	}

	getActiveView(): MiniApp | ContainerView | null {
		return this.views[this.views.length - 1] || this.rootView
	}

	sleepActiveView(): void {
		if (this.isSleeping) {
			return
		}

		this.isSleeping = true
		this.getActiveView()?.onPresentOut?.()
	}

	wakeActiveView(): void {
		if (!this.isSleeping) {
			return
		}

		this.isSleeping = false
		const activeView = this.getActiveView()
		activeView?.restoreColorStyle?.()
		activeView?.onPresentIn?.()
	}

	updateStatusBarColor(color: string): void {
		this.shell.updateStatusBarColor(color)
	}
}
