import type { Application } from '../application/application.js'
import type { BridgeOptions, MiniProgramReferrerInfo, PageStackEntry, StorageAdapter } from '../../types.js'
import type { ApiParams, SocketEventName } from '../../core/webSocketManager.js'
import type { AppWindowConfig, MergedPageConfig, PageConfig } from '../../utils/util.js'
import { LAUNCH_SCREEN_MIN_MS, MODAL_GUARD_MS, WAIT_TRANSITION_TIMEOUT_MS } from '../../constants/animation.js'
import { Bridge } from '../../core/bridge.js'
import { JSCore } from '../../core/jscore.js'
import { WebSocketManager } from '../../core/webSocketManager.js'
import { readWebFile, saveWebFile, VIRTUAL_FILE_PREFIX, VIRTUAL_USER_PREFIX } from '../../core/webFileSystem.js'
import { resolveStorageAdapter } from '../../config.js'
import { mergePageConfig, queryPath, readFile, sleep, uuid } from '../../utils/util.js'
import { Navigator } from './navigator.js'

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
import tpl from './miniApp.html?raw'
import './miniApp.scss'

function preventModalTouchMove(event: TouchEvent): void {
	if (event.cancelable) {
		event.preventDefault()
	}
}

function blockModalPageTouchMove(event: TouchEvent): void {
	preventModalTouchMove(event)
	event.stopImmediatePropagation?.()
}

/**
 * 逻辑线程 invokeAPI 传入的回调标识（success/fail/complete）：形状由 service 侧
 * 决定，这里只做 truthy 判断后经 triggerCallback 原样带回。
 */
type CallbackId = unknown
type ApiCallback = (args?: unknown) => void

const STORAGE_V2_DATA_PREFIX = '__dimina_storage_v2_data__'
const STORAGE_V2_META_PREFIX = '__dimina_storage_v2_meta__'

interface StorageValueRecord {
	version: 2
	kind: 'value' | 'deleted'
	dataType?: 'json' | 'undefined'
	data?: unknown
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

interface ApiCallbackOptions {
	success?: CallbackId
	fail?: CallbackId
	complete?: CallbackId
}

export interface MiniAppOptions {
	appId: string
	scene?: number
	referrerInfo?: MiniProgramReferrerInfo
	/** 打开当前小程序的直接来源；仅容器内部用于 navigateBackMiniProgram。 */
	opener?: MiniApp | null
	name?: string
	logo?: string
	pagePath: string
	query?: Record<string, string>
	/** 完整页面栈，用于刷新后静默恢复 */
	restoreStack?: Array<{ pagePath: string, query?: Record<string, string> }>
	/** 逐 app 覆盖容器默认 resourceBaseUrl；已由 AppManager 解析并校验过 allowedOrigins。 */
	resourceBaseUrl?: string
}

interface TabBarItemConfig {
	pagePath: string
	text?: string
	iconPath?: string
	selectedIconPath?: string
}

interface TabBarConfig {
	color?: string
	selectedColor?: string
	backgroundColor?: string
	borderStyle?: 'black' | 'white'
	custom?: boolean
	list: TabBarItemConfig[]
}

interface AppConfigApp {
	entryPagePath: string
	pages: string[]
	runtimeType?: 'miniProgram' | 'game'
	window?: AppWindowConfig
	tabBar?: TabBarConfig
	networkTimeout?: {
		connectSocket?: number
	}
}

export interface MiniAppConfig {
	app: AppConfigApp
	modules: Record<string, PageConfig>
}

interface ToastInfo {
	dom: HTMLElement | null
	timer: ReturnType<typeof setTimeout> | null
	maskEl?: HTMLElement | null
}

interface ModalCloseResult {
	cancel: boolean
	confirm: boolean
	errMsg: string
}

interface ModalEntry {
	mask: HTMLElement
	dialog: HTMLElement
	close: ((result?: ModalCloseResult) => void) | null
}

interface ShowToastOptions extends ApiCallbackOptions {
	title?: string
	duration?: number
	icon?: string
	mask?: boolean
}

interface ShowModalOptions extends ApiCallbackOptions {
	title?: string
	content?: string
	showCancel?: boolean
	cancelText?: string
	cancelColor?: string
	confirmText?: string
	confirmColor?: string
}

interface ShowActionSheetOptions {
	itemList?: string[]
	itemColor?: string
	success?: CallbackId
	fail?: CallbackId
	complete?: CallbackId
}

interface NavigateOptions extends ApiCallbackOptions {
	url: string
}

interface SetNavigationBarTitleOptions extends ApiCallbackOptions {
	title?: string
}

interface SetNavigationBarColorOptions extends ApiCallbackOptions {
	frontColor?: string
	backgroundColor?: string
}

interface PageScrollToOptions extends ApiCallbackOptions {
	scrollTop?: number
	duration?: number
}

interface SetClipboardDataOptions extends ApiCallbackOptions {
	data: string
}

interface StorageKeyOptions extends ApiCallbackOptions {
	key: string
}

interface SetStorageOptions extends StorageKeyOptions {
	data: unknown
}

interface SaveFileOptions extends ApiCallbackOptions {
	tempFilePath?: string
	filePath?: string
}

interface NetworkInformationLike extends EventTarget {
	effectiveType?: string
	type?: string
}

interface WakeLockSentinelLike {
	released?: boolean
	release: () => Promise<void>
	addEventListener?: (type: 'release', listener: () => void, options?: AddEventListenerOptions) => void
}

interface NavigatorWithDeviceApis {
	connection?: NetworkInformationLike
	mozConnection?: NetworkInformationLike
	webkitConnection?: NetworkInformationLike
	wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
}

interface SetTabBarStyleOptions extends ApiCallbackOptions {
	color?: string
	selectedColor?: string
	backgroundColor?: string
	borderStyle?: string
}

interface SetTabBarItemOptions extends ApiCallbackOptions {
	index?: number | string
	text?: string
	iconPath?: string
	selectedIconPath?: string
}

interface TabBarIndexOptions extends ApiCallbackOptions {
	index?: number | string
}

interface TabBarBadgeOptions extends TabBarIndexOptions {
	text?: string
}

interface NavigateToMiniProgramOptions extends ApiCallbackOptions {
	appId?: string
	path?: string
	extraData?: unknown
	envVersion?: 'develop' | 'trial' | 'release'
	noRelaunchIfPathUnchanged?: boolean
	shortLink?: string
}

interface NavigateBackMiniProgramOptions extends ApiCallbackOptions {
	extraData?: unknown
}

interface RestartMiniProgramOptions extends ApiCallbackOptions {
	path?: string
}

interface ExtCallParams {
	module?: string
	data?: unknown
	success?: CallbackId
	fail?: CallbackId
	complete?: CallbackId
	evtId?: unknown
}

export class MiniApp {
	appInfo: MiniAppOptions
	id: string
	parent: Application | null
	appId: string
	opener: MiniApp | null
	appConfig: MiniAppConfig | null
	runtimeType: 'miniProgram' | 'game'
	navigator: Navigator
	jscore: JSCore
	webviewsContainer: HTMLElement | null
	webviewAnimaEnd: boolean
	el: HTMLElement
	toastInfo: ToastInfo
	color: string | null
	apiRegistry: Record<string, (this: MiniApp, params?: unknown, callerBridge?: Bridge) => void>
	webSocketManager: WebSocketManager
	/** 维护第三方扩展的持续订阅，key: `${module}_${event}`，value: unsubscribe 函数 */
	_extSubscriptions: Map<string, (() => void) | null>
	_windowResizeHandlers: Set<() => void>
	_networkStatusHandlers: Map<CallbackId, () => void>
	_wakeLockSentinel: WakeLockSentinelLike | null
	_wakeLockRequest: Promise<void> | null
	_keepScreenOnRequested: boolean
	_wakeLockVisibilityHandler: (() => void) | null
	_mediaPreviewEl: HTMLElement | null
	_tempObjectUrls: Set<string>
	/** app.tabBar 配置 */
	tabBarConfig: TabBarConfig | null
	/** 与 list 等长，pagePath 数组（已规范化、无前导 /） */
	tabBarPaths: string[]
	/** .dimina-mini-app__tabbar 根节点 */
	tabBarEl: HTMLElement | null
	/** TabBar 实际高度，用于给 tab 页 webview 单独预留底部空间 */
	tabBarHeight: number
	/** 每个 tab item 的 badge 文本 */
	tabBarBadges: string[]
	/** 每个 tab item 的红点显示状态 */
	tabBarRedDots: boolean[]
	/** wx.showTabBar/hideTabBar 控制的显隐开关 */
	tabBarApiVisible: boolean
	/**
	 * showModal 用 LIFO stack：后来的 modal 压在前一个之上（z-index 递增），
	 * 关闭顶上 modal 露出下方；前后 modal 互不干扰，各自 success/complete 独立。
	 */
	_modalStack: ModalEntry[]
	_modalPendingTimers: Set<ReturnType<typeof setTimeout>>
	/** showModal 期间锁定的、承载当前页面内容的渲染 iframe window；未锁定时为 null。 */
	_modalPageTouchTarget: Window | null
	_destroyed: boolean
	/** Whether every live page has already queued its terminal Page.onUnload. */
	_destructionLifecycleQueued: boolean
	/** destroy() 时 abort，用于打断在途的 bridge.init()（见 frameLoaded 的 AbortSignal 用法）。 */
	_destroyAbortController: AbortController
	customTabBar: boolean = false
	_themeMediaQuery: MediaQueryList | null = null
	_themeChangeHandler: ((event: MediaQueryListEvent) => void) | null = null
	_tabBarResizeObserver: ResizeObserver | null = null

	constructor(opts: MiniAppOptions) {
		this.appInfo = opts
		this.id = `mini_app_${uuid()}`
		this.parent = null
		this.appId = opts.appId
		this.opener = opts.opener ?? null
		this.appConfig = null
		this.runtimeType = 'miniProgram'
		this.navigator = new Navigator()
		this.jscore = new JSCore(this)
		this.webviewsContainer = null
		this.webviewAnimaEnd = true
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
		this.toastInfo = {
			dom: null,
			timer: null,
		}
		this.color = null
		this.apiRegistry = {}
		this.webSocketManager = new WebSocketManager({
			emitCallback: (callbackId, payload) => this.createCallbackFunction(callbackId)?.(payload),
			getAppConnectTimeout: () => this.appConfig?.app.networkTimeout?.connectSocket,
		})
		this._extSubscriptions = new Map()
		this._windowResizeHandlers = new Set()
		this._networkStatusHandlers = new Map()
		this._wakeLockSentinel = null
		this._wakeLockRequest = null
		this._keepScreenOnRequested = false
		this._wakeLockVisibilityHandler = null
		this._mediaPreviewEl = null
		this._tempObjectUrls = new Set()
		this.tabBarConfig = null
		this.tabBarPaths = []
		this.tabBarEl = null
		this.tabBarHeight = 0
		this.tabBarBadges = []
		this.tabBarRedDots = []
		this.tabBarApiVisible = true
		this._modalStack = []
		this._modalPendingTimers = new Set()
		this._modalPageTouchTarget = null
		this._modalPageTouchTarget = null
		this._destroyed = false
		this._destructionLifecycleQueued = false
		this._destroyAbortController = new AbortController()
	}

	/** 入口页路径（无前导 /）：openApp 解析后的结果，宿主可读。 */
	get pagePath(): string {
		return this.appInfo.pagePath
	}

	/** 入口页 query：openApp 解析后的结果，宿主可读。 */
	get query(): Record<string, string> {
		return this.appInfo.query ?? {}
	}

	/**
	 * 规范化 pagePath：去除前导 /，与 app.tabBar.list 中声明的格式对齐。
	 */
	_normalizePagePath(path?: string | null): string {
		// 运行时来源是用户工程的 app-config，可能出现非字符串畸形值，一律按空路径处理。
		if (!path || typeof path !== 'string')
			return ''
		return path.startsWith('/') ? path.slice(1) : path
	}

	/**
	 * 判断给定路径是否为 tabBar 页面。
	 */
	_isTabBarPage(pagePath?: string | null): boolean {
		return this.tabBarPaths.includes(this._normalizePagePath(pagePath))
	}

	getCurrentPagePath(): string {
		const currentBridge = this.navigator.top
		return currentBridge?.opts?.pagePath || this.appInfo.pagePath || this.appConfig?.app?.entryPagePath || ''
	}

	getCurrentPageQuery(): Record<string, string> {
		const currentBridge = this.navigator.top
		return currentBridge?.opts?.query || this.appInfo.query || {}
	}

	getEntryPagePath(): string {
		return this.appInfo.pagePath || this.appConfig?.app?.entryPagePath || ''
	}

	/**
	 * 应用首页——返回首页按钮的跳转目标与其显示判据的比较对象。
	 * 取配置声明的 entryPagePath（缺省 pages[0]），不受 deep-link 启动页影响。
	 */
	getHomePagePath(): string {
		return this._normalizePagePath(this.appConfig?.app?.entryPagePath || this.appConfig?.app?.pages?.[0] || '')
	}

	/**
	 * 返回首页按钮显示判据（微信真机实测语义）：默认导航栏 + 当前页非应用首页 +
	 * 非 tabBar 页（这两条排除 homeButton: true 也不能突破），且满足其一：
	 * 栈底页面（自动规则），或页面配置 homeButton: true（此时与返回箭头并存）。
	 * wx.hideHomeButton 的隐藏作用在 webview 上（setHomeButtonVisible），不在这里
	 */
	shouldShowHomeButton({ pagePath, configInfo, isRoot }: { pagePath?: string | null, configInfo?: MergedPageConfig, isRoot?: boolean }): boolean {
		if (configInfo?.navigationStyle === 'custom') {
			return false
		}
		const homePagePath = this.getHomePagePath()
		if (!homePagePath) {
			return false
		}
		const normalized = this._normalizePagePath(pagePath)
		if (this._isTabBarPage(normalized) || normalized === homePagePath) {
			return false
		}
		return isRoot === true || configInfo?.homeButton === true
	}

	/**
	 * 返回首页（导航栏 home 按钮的唯一路由入口），终态都是只剩首页：
	 * 首页是 tab 页走 switchTab（保留其它 tab 状态并露出 tabBar，自带清非 tab 栈）；
	 * 首页非 tab 且当前是栈底，redirectTo 原地替换；非栈底（homeButton: true 的
	 * 内页）redirect 只会替换栈顶、栈底仍在，须 reLaunch 清整栈
	 */
	navigateHome(): void {
		const homePagePath = this.getHomePagePath()
		if (!homePagePath) {
			return
		}
		if (this._isTabBarPage(homePagePath)) {
			void this.switchTab({ url: `/${homePagePath}` })
		}
		else if (this.navigator.size <= 1) {
			this.redirectTo({ url: `/${homePagePath}` })
		}
		else {
			this.reLaunch({ url: `/${homePagePath}` })
		}
	}

	/**
	 * wx.hideHomeButton：隐藏调用页自己的返回首页按钮。经 bridge 归属调用方，
	 * 后台页的迟到调用不会隐藏当前可见页面的按钮
	 */
	hideHomeButton(opts: ApiCallbackOptions = {}, callerBridge?: Bridge): void {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		const bridge = callerBridge || this.navigator.top
		bridge?.webview?.setHomeButtonVisible(false)
		onSuccess?.({ errMsg: 'hideHomeButton:ok' })
		onComplete?.()
	}

	async copyText(text: string, successText?: string): Promise<void> {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text)
			}
			else {
				const textarea = document.createElement('textarea')
				textarea.value = text
				textarea.setAttribute('readonly', 'readonly')
				textarea.style.position = 'fixed'
				textarea.style.opacity = '0'
				document.body.appendChild(textarea)
				textarea.select()
				document.execCommand('copy')
				document.body.removeChild(textarea)
			}
			this.showToast({
				title: successText,
				icon: 'success',
			})
		}
		catch {
			this.showToast({
				title: '复制失败',
				icon: 'none',
			})
		}
	}

	closeMiniProgram(): void {
		this.closeMiniAppMenu()
		// URL 是否/如何变化由 Application.syncUrl()（dismissView 收尾时统一调用）
		// 决定——关闭后若还有其它实例在下面，地址栏应反映它，而不是被无条件清空。
		this.parent!.appManager.closeApp(this)
	}

	renderMiniAppMenu(): void {
		const name = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__app-name')!
		const appId = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__app-id')!
		const desc = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__app-desc')!
		const logo = this.el.querySelector<HTMLImageElement>('.dimina-mini-app-menu__app-logo-img')!
		const quickActions = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__quick-actions')!
		const currentPagePath = this.getCurrentPagePath()
		const entryPagePath = this.getEntryPagePath()
		const pagePath = currentPagePath || entryPagePath || ''
		// "复制链接" 必须经由容器当前生效的 urlSync 适配器构建，不能直接碰内置
		// QueryRouter——urlSync:false 或不实现 buildShareUrl 的自定义适配器都意味着
		// 宿主从未把这个地址同步到地址栏，猜出来的链接打不开，因此整项隐藏而非拼错误值。
		// 栈必须取 this.getPageStack()（navigator 的真实当前栈），不能手拼
		// entryPagePath——entryPagePath 固定在 open 时刻的启动页，reLaunch() 到
		// 另一个页面之后就与地址栏实际同步的栈根分道扬镳，拼出来的链接会跟地址栏对不上。
		const shareUrl = this.parent?.urlSync?.buildShareUrl?.(this.appId, this.getPageStack())

		name.textContent = this.appInfo.name || '未命名小程序'
		appId.textContent = `AppID：${this.appId || '--'}`
		desc.textContent = `当前页面：${pagePath || '--'}`
		logo.src = this.appInfo.logo || ''

		const quickActionItems = [
			...(shareUrl
				? [{
						label: '复制链接',
						icon: '↗',
						handler: () => this.copyText(shareUrl, '链接已复制'),
					}]
				: []),
			{
				label: '重新进入',
				icon: '↻',
				handler: () => {
					this.closeMiniAppMenu()
					this.reLaunch({
						url: entryPagePath || currentPagePath,
					})
				},
			},
			{
				label: '关闭小程序',
				icon: '×',
				danger: true,
				handler: () => this.closeMiniProgram(),
			},
		]

		// 列数跟随实际渲染的快捷操作数(2 或 3)，避免固定 3 列在只有 2 项时
		// 留出一个视觉上空着的第三格。
		quickActions.style.gridTemplateColumns = `repeat(${quickActionItems.length}, minmax(0, 1fr))`

		quickActions.innerHTML = quickActionItems
			.map((item, index) => `
				<button type="button" class="dimina-mini-app-menu__quick-action${item.danger ? ' is-danger' : ''}" data-quick-index="${index}">
					<span class="dimina-mini-app-menu__quick-action-icon">${item.icon}</span>
					<span class="dimina-mini-app-menu__quick-action-label">${item.label}</span>
				</button>
			`)
			.join('')

		quickActions.querySelectorAll<HTMLElement>('[data-quick-index]').forEach((node, index) => {
			node.onclick = () => quickActionItems[index].handler()
		})
	}

	openMiniAppMenu(): void {
		const overlay = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__mask')!
		const menu = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu')!
		this.renderMiniAppMenu()
		overlay.style.display = 'block'
		requestAnimationFrame(() => {
			overlay.classList.add('show')
			menu.classList.add('show')
		})
	}

	closeMiniAppMenu(): void {
		const overlay = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__mask')!
		const menu = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu')!
		overlay.classList.remove('show')
		menu.classList.remove('show')
	}

	registerApi(name: string, handler: (this: MiniApp, params?: unknown) => void): void {
		this.apiRegistry[name] = handler
	}

	getApiNamespaces(): string[] {
		return this.parent?.apiNamespaces ?? []
	}

	getResourceBaseUrl(): string {
		return this.appInfo.resourceBaseUrl ?? this.parent?.resourceBaseUrl ?? '/'
	}

	getPageFrameUrl(): string {
		return this.parent?.pageFrameUrl ?? `${this.getResourceBaseUrl()}pageFrame.html`
	}

	_getStatusBarRect() {
		return this.parent?.shell?.getStatusBarRect?.() ?? { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }
	}

	/**
	 * wx 存储 API（setStorage/getStorage/removeStorage/clearStorage/getStorageInfo）
	 * 落地的适配器：parent（Application）持有 createContainer({ storageSync }) 已 resolve
	 * 好的实例；未挂载 parent 时兜底走内置 window.localStorage，与 resolveStorageAdapter(true) 一致。
	 */
	_getStorageAdapter(): StorageAdapter {
		return this.parent?.storageAdapter ?? resolveStorageAdapter(true)
	}

	/** Length-prefixed appId makes the (appId, key) mapping unambiguous. */
	_storageKey(key: string): string {
		return `${this._storageKeyPrefix()}${key}`
	}

	_storageKeyPrefix(): string {
		return `${STORAGE_V2_DATA_PREFIX}${this.appId.length}:${this.appId}:`
	}

	_legacyStorageKey(key: string): string {
		return `${this.appId}_${key}`
	}

	_legacyStorageDisabledKey(): string {
		return `${STORAGE_V2_META_PREFIX}${this.appId.length}:${this.appId}:legacy-disabled`
	}

	_serializeStorageValue(data: unknown): string {
		const record: StorageValueRecord = data === undefined
			? { version: 2, kind: 'value', dataType: 'undefined' }
			: { version: 2, kind: 'value', dataType: 'json', data }
		return JSON.stringify(record)
	}

	_serializeStorageTombstone(): string {
		return JSON.stringify({ version: 2, kind: 'deleted' } satisfies StorageValueRecord)
	}

	_decodeStorageRecord(raw: string): StorageValueRecord {
		const value = JSON.parse(raw) as Partial<StorageValueRecord> | null
		if (!value || value.version !== 2 || (value.kind !== 'value' && value.kind !== 'deleted')) {
			throw new Error('invalid storage record')
		}
		if (value.kind === 'value' && value.dataType !== 'json' && value.dataType !== 'undefined') {
			throw new Error('invalid storage value type')
		}
		return value as StorageValueRecord
	}

	_decodeLegacyStorageValue(raw: string): unknown {
		try {
			return JSON.parse(raw)
		}
		catch {
			return raw
		}
	}

	_readStorageValue(storageAdapter: StorageAdapter, key: string): { found: boolean, data?: unknown } {
		const storageKey = this._storageKey(key)
		const current = storageAdapter.getItem(storageKey)
		if (current !== null) {
			const record = this._decodeStorageRecord(current)
			if (record.kind === 'deleted') {
				return { found: false }
			}
			return { found: true, data: record.dataType === 'undefined' ? undefined : record.data }
		}

		// Old `${appId}_${key}` data remains readable and is lazily copied into
		// the collision-free namespace. The old entry is intentionally retained:
		// its spelling may also represent another app's legacy key.
		if (
			storageAdapter.getItem(this._legacyStorageDisabledKey()) === '1'
			|| this.appId.includes('_')
			|| key.includes('_')
		) {
			return { found: false }
		}
		const legacy = storageAdapter.getItem(this._legacyStorageKey(key))
		if (legacy === null) {
			return { found: false }
		}
		const data = this._decodeLegacyStorageValue(legacy)
		storageAdapter.setItem(storageKey, this._serializeStorageValue(data))
		return { found: true, data }
	}

	/**
	 * 唯一判据：这个 MiniApp 此刻是否真的呈现在展示栈最前面。后台实例上任何让 bridge
	 * 变为可见、或把配色推给宿主 shell 的操作都必须先过这道闸。未挂载 parent（尚未接入
	 * 任何 Application 展示栈，如独立单测）时不存在"被别的实例挤到后台"的可能，视为
	 * 呈现在最前——fail-open，不是 fail-closed。
	 */
	private isPresentedTop(): boolean {
		return !this.parent || (this.parent.getActiveView() === this && !this.parent.isSleeping)
	}

	/**
	 * 地址栏同步是尽力而为的旁路通知：宿主的 urlSync 适配器抛错，不能冒充"这次
	 * 导航/呈现本身失败了"，也不能中断已经完成的页面切换——因此统一收窄异常。
	 */
	private safeSyncUrl(): void {
		try {
			this.parent?.syncUrl()
		}
		catch {
			// 见上方注释
		}
	}

	/**
	 * 按名称调用 API：自定义注册 → 内置方法 → 第三方扩展路由。
	 * callerBridge 为发起调用的页面 bridge，供 hideHomeButton 这类作用于
	 * 「调用页自身」的 API 定位页面。
	 */
	invokeApi(name: string, params?: Record<string, unknown>, callerBridge?: Bridge): void {
		const handler = this.apiRegistry[name]
		if (handler) {
			handler.call(this, params, callerBridge)
		}
		else if (typeof (this as unknown as Record<string, unknown>)[name] === 'function') {
			// 按字符串名字动态派发到内置 API 方法，编译期无法收敛成方法名联合类型。
			(this as unknown as Record<string, (params?: unknown, callerBridge?: Bridge) => void>)[name](params, callerBridge)
		}
		else if (params?.module !== undefined || params?.evtId !== undefined) {
			// 扩展调用必须携带明确的协议标记，不能仅凭 success 判断，
			// 否则未实现的普通回调 API 会被误判为 extOnBridge。
			this._handleExtCall(name, params as ExtCallParams)
		}
		else {
			this._handleUnsupportedApi(name, params)
		}
	}

	_handleUnsupportedApi(name: string, params: Record<string, unknown> = {}): void {
		const { onFail, onComplete } = this._createApiCallbacks(params as ApiCallbackOptions)
		const error = { errMsg: `${name}:fail api is not supported` }
		if (params.fail) {
			onFail?.(error)
		}
		else {
			console.warn(`[container] ${error.errMsg}`)
		}
		onComplete?.()
	}

	_prepareViewForLoad(): void {
		this.initPageFrame()
		this.webviewsContainer = this.el.querySelector<HTMLElement>('.dimina-mini-app__webviews')
		this.showLaunchScreen()
		this.bindMoreEvent()
		this.bindCloseEvent()
	}

	viewDidLoad(): void {
		this._prepareViewForLoad()
		// initApp() 是 fire-and-forget：真实初始化失败必须落日志并通知宿主，
		// 否则 openApp 照常 resolve、页面却空白，宿主收不到任何信号。
		this.initApp().catch((error: unknown) => {
			// 容器销毁打断初始化是正常流程，不是启动失败。abort 判定优先看
			// _destroyed 这个本地标志——它总是可靠；error.name 判定见 bridge.ts
			// createWebview 的说明（instanceof DOMException 才是跨 realm 会失效的那个）。
			if (this._destroyed || (error instanceof Error && error.name === 'AbortError')) {
				return
			}
			console.error(`[container] initApp failed for ${this.appId}:`, error)
			this.parent?.onAppLaunchError?.(error, { appId: this.appId })
		})
	}

	/**
	 * restartMiniProgram 的替换实例要把初始化结果作为事务提交点：
	 * 新 Worker/Bridge 未真正就绪前保留旧 runtime，失败则由 Application 原位回滚。
	 */
	async viewDidLoadForReplacement(): Promise<void> {
		this._prepareViewForLoad()
		await this.initApp(false, true)
	}

	async initApp(removeFailedViewOnError = true, waitForInitialResources = false): Promise<void> {
		// 与 navigateTo/redirectTo/navigateBack/switchTab/reLaunch 共享同一把忙锁：
		// 静默恢复阶段还有 createBridge() 挂在半空中时，并发的导航调用必须被这道锁
		// 挡住，不能在 restore 还没收尾的 navigator 上直接继续操作。
		this.webviewAnimaEnd = false
		try {
			// 1. 等待逻辑线程初始化
			await this.jscore.init()
			this._bindThemeChange()

			// 2. 读取配置文件，同时保证 LaunchScreen 最少展示一个略长于 present 的时长
			const root = 'main'
			const configPath = `${this.appInfo.appId}/${root}/app-config.json`
			const [configContent] = await Promise.all([
				readFile(`${this.getResourceBaseUrl()}${configPath}`),
				sleep(LAUNCH_SCREEN_MIN_MS),
			])

			// 正常的容器销毁不算加载失败，安静退出。
			if (this._destroyed) {
				return
			}

			// readFile 对 404/网络失败返回 null（见 utils/util.ts）：抛出让 viewDidLoad
			// 的 catch 统一走 onAppLaunchError（非法 JSON 的 SyntaxError 同样冒泡到那里）。
			if (!configContent) {
				throw new Error(`[container] failed to load app config: ${configPath}`)
			}

			this.appConfig = JSON.parse(configContent)
			this.runtimeType = this.appConfig?.app?.runtimeType === 'game' ? 'game' : 'miniProgram'
			this.el.classList.toggle('dimina-native-view--game', this.runtimeType === 'game')

			// 缓存 tabBar 配置（list、color 等），并渲染 tabBar 容器；后续仅做选中态/可见性切换
			this._initTabBar()

			const entryPagePath = this.runtimeType === 'game'
				? (this.appConfig!.app.entryPagePath || 'game')
				: (this.appInfo.pagePath || this.appConfig!.app.entryPagePath)
			// navigateToMiniProgram 允许省略 path。配置加载后把真实入口回填到实例元数据，
			// 让后续 restart/referrer/宿主读取都看到实际页面，而不是永久保留空字符串。
			if (!this.appInfo.pagePath) {
				this.appInfo.pagePath = entryPagePath
			}
			if (
				waitForInitialResources
				&& !this.appConfig!.app.pages.some(path => this._normalizePagePath(path) === this._normalizePagePath(entryPagePath))
			) {
				throw new Error(`[container] page is not declared in app config: ${entryPagePath}`)
			}

			// 4. 读取页面配置
			const pageConfig = this.appConfig!.modules[entryPagePath]
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			// 5. 设置状态栏的颜色模式
			this.updateTargetPageColorStyle(mergeConfig)

			// 6. 创建通信 bridge
			const entryPageBridge = await this.createBridge({
				pagePath: entryPagePath,
				query: this.appInfo.query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: true,
				root,
				appId: this.appInfo.appId,
				pages: this.appConfig!.app.pages,
				configInfo: mergeConfig,
			})

			// bridge.init() 可能被并发 destroy() 打断；销毁路径上直接停止。
			if (this._destroyed) {
				return
			}

			this.navigator.pushPage(entryPageBridge)

			// 入口若是 tab 页：登记到 tab 池并设为当前 tab、显示 TabBar
			if (this._isTabBarPage(entryPagePath)) {
				const normalizedPath = this._normalizePagePath(entryPagePath)
				this.navigator.setTabBridge(normalizedPath, entryPageBridge)
				this.navigator.setActiveTabPath(normalizedPath)
				this._setTabBarVisible(true)
				this._updateTabBarSelection(normalizedPath)
			}

			const isRestoringPageStack = (this.appInfo.restoreStack?.length ?? 0) > 1
			const startOptions = { visible: !isRestoringPageStack && this.isPresentedTop() }
			if (isRestoringPageStack) {
				// 恢复栈时根页会被后续页面覆盖；替换 runtime 仍需先确认根页完整就绪，
				// 普通冷启动则直接开始加载，最终由真实栈顶页的 domReady 关闭遮罩。
				if (waitForInitialResources) {
					await entryPageBridge.startAndWait(startOptions)
				}
				else {
					entryPageBridge.start(startOptions)
				}

				// 7. 若携带额外的恢复栈（刷新后恢复场景），静默重建后续页面
				await this.restorePageStack(this.appInfo.restoreStack!.slice(1))
				if (this._destroyed) {
					return
				}
			}
			else {
				// 资源加载完成不代表首屏已经挂载；页面与小游戏统一等本轮 domReady。
				await entryPageBridge.startAndWait(startOptions)
			}

			this.safeSyncUrl()

			// 8. 隐藏 loading
			this.hideLaunchScreen()
		}
		catch (error) {
			// 启动（含静默恢复）中途失败：已创建成功的 bridge 必须先销毁，不能只清
			// 记账留下 DOM/jscore 泄漏；这个实例从未真正呈现成功，不能继续留在
			// AppManager 登记表或 Application.views 里假装自己是个有效实例，
			// 让下一次针对同一 appId 的 openApp() 能重新构建一个干净实例。
			const orphanBridges = new Set([...this.navigator.getStack(), ...this.navigator.getTabBridges()])
			for (const bridge of orphanBridges) {
				bridge.destroy()
				bridge.webview?.el?.remove()
			}
			this.navigator.clear()
			// 地址栏同步、上报、destroy() 先同步跑完，不提前 await removeFailedView()——
			// 它经 Application._enqueue() 串行化，此刻可能排在仍在途的 presentView()
			// 动画收尾之后；等它才做下面几步会让资源回收（jscore worker 终止等）被
			// 无谓延后到那条队列轮到自己才发生。safeSyncUrl() 内部已经吞掉地址栏
			// 适配器异常，这里的顺序不再是为了"抢在一次未防护的异常之前"，只是为了
			// 不必要地拖慢收尾。
			this.safeSyncUrl()
			// 复用 destroy() 做完整收尾（jscore worker、主题监听器、弹窗计时器等），
			// 不再手搓一份只清 bridge 的残缺版本；appManager 摘除已经在 destroy() 内部
			// 处理，不需要重复调用。destroy() 会置 _destroyed=true，这会让下面
			// viewDidLoad().catch() 里的 onAppLaunchError 上报被跳过，所以必须在这里
			// 先直接上报一次，不能依赖外层 catch。
			console.error(`[container] initApp failed for ${this.appId}:`, error)
			try {
				this.parent?.onAppLaunchError?.(error, { appId: this.appId })
			}
			catch (reportError) {
				// 宿主回调是不可信代码；它自己抛错不能挡住下面必须执行的资源回收。
				console.error(`[container] onAppLaunchError threw for ${this.appId}:`, reportError)
			}
			try {
				this.destroy()
			}
			catch (destroyError) {
				// destroy() 若因扩展模块 unsubscribe 抛错会在完成收尾后重新抛出
				// （见 destroy() 自身契约）；那不能顶替这里真正要上抛的启动失败原因。
				console.error(`[container] destroy() threw during initApp failure cleanup for ${this.appId}:`, destroyError)
			}
			if (removeFailedViewOnError) {
				await this.parent?.removeFailedView(this)
			}
			throw error
		}
		finally {
			this.webviewAnimaEnd = true
		}
	}

	/**
	 * 静默恢复页面栈中根页之后的页面。
	 * 这些页面的 bridge 会被初始化并推入 navigator 的主栈，但不播放入场动画，
	 * 当前页显示在最顶层，之前的页面以 slide-out 状态保留在 DOM 中，
	 * 使后退按钮可以正常工作。
	 * @param {Array<{pagePath: string, query: object}>} pages
	 */
	async restorePageStack(pages: Array<{ pagePath: string, query?: Record<string, string> }>): Promise<void> {
		for (let i = 0; i < pages.length; i++) {
			const { pagePath: rawPagePath, query } = pages[i]
			const isTop = i === pages.length - 1

			// 规范化路径：去掉前导 /，与 app-config.json modules key 保持一致
			const pagePath = rawPagePath.startsWith('/') ? rawPagePath.slice(1) : rawPagePath
			// pageConfig 可能为空（该小程序所有页面共用 app.window 默认配置），
			// mergePageConfig 支持 pageConfig 为 undefined，直接降级到 app 全局配置
			const pageConfig = this.appConfig!.modules[pagePath]
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			const bridge = await this.createBridge({
				pagePath,
				query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: false,
				root: pageConfig?.root || 'main',
				appId: this.appInfo.appId,
				pages: this.appConfig!.app.pages,
				configInfo: mergeConfig,
			})
			// bridge.init() 可能被并发 destroy() 打断；销毁路径上直接停止。
			if (this._destroyed) {
				return
			}

			// 将上一个页面移到 slide-out 状态（不可见但保留在栈中，支持后退）
			const prevBridge = this.navigator.top!
			prevBridge.webview!.el.classList.remove('dimina-native-view--instage')
			prevBridge.webview!.el.classList.add('dimina-native-view--slide-out')

			this.navigator.pushPage(bridge)
			bridge.webview!.el.style.zIndex = String(this.navigator.size + 1)

			// 移除 before-enter（translateX 100%），让页面回到正常位置
			bridge.webview!.el.classList.remove('dimina-native-view--before-enter')
			if (!isTop) {
				// 中间页面再叠加 slide-out，被上层页面覆盖
				bridge.webview!.el.classList.add('dimina-native-view--slide-out')
			}

			const startOptions = { visible: isTop && this.isPresentedTop() }
			if (isTop) {
				// 启动遮罩覆盖的是恢复后的栈顶页，不能被底层页面的迟到 ready 提前关闭。
				await bridge.startAndWait(startOptions)
			}
			else {
				bridge.start(startOptions)
			}
		}

		if (pages.length > 0) {
			// 最顶层页面更新状态栏颜色
			const topBridge = this.navigator.top!
			const topPageConfig = this.appConfig!.modules[topBridge.opts.pagePath]
			const topMergeConfig = mergePageConfig(this.appConfig!.app, topPageConfig)
			this.updateTargetPageColorStyle(topMergeConfig)

			// 恢复后栈顶为非 tab 页：隐藏 TabBar（tab bridge 仍保留在 pool 中以备后退恢复）
			if (!this._isTabBarPage(topBridge.opts.pagePath)) {
				this._setTabBarVisible(false)
			}
		}
	}

	/**
	 * 把当前主栈转成页面栈的最小形状（pagePath + query），供地址栏路由同步、
	 * 刷新后恢复使用。纯派生，不产生副作用——是否/何时真正回写地址栏由 Application
	 * 统一决定（只有当前栈顶实例的页面栈才应该出现在地址栏上）。
	 * pagePath 统一去掉前导 /，与 app-config.json modules key 保持一致。
	 */
	getPageStack(): PageStackEntry[] {
		return this.navigator.getPageStack()
	}

	// 创建一个bridge对象
	async createBridge(opts: BridgeOptions & { jscore: JSCore }): Promise<Bridge> {
		const { jscore, configInfo, isRoot, appId, pagePath, query, scene, pages, root } = opts
		const bridge = new Bridge({
			jscore,
			configInfo,
			isRoot,
			appId,
			runtimeType: this.runtimeType,
			pagePath,
			query,
			scene,
			referrerInfo: opts.referrerInfo ?? this.appInfo.referrerInfo,
			pages,
			root,
		})

		bridge.parent = this
		await bridge.init(this._destroyAbortController.signal)
		return bridge
	}

	queueAppShowOptions(options: Record<string, unknown>): void {
		this.jscore.queueAppShowOptions(options)
	}

	onPresentIn(): void {
		const currentBridge = this.navigator.top
		this.webSocketManager.onAppShow()
		// appShow/appHide 是 app 粒度信号，由共享的 jscore 统一记账去重，不挂在
		// 当前栈顶这一个 Bridge 上——见 JSCore.appShow() 上的说明。
		this.jscore.appShow()
		currentBridge?.pageShow()
	}

	onPresentOut(): void {
		const currentBridge = this.navigator.top

		currentBridge?.pageHide()
		this.webSocketManager.onAppHide()
		this.jscore.appHide()
	}

	/**
	 * 回收整个小程序的 Bridge 资源，排在调用方的 FIFO 回调 barrier 之前。这条链路只由退出
	 * 小程序和整体换 runtime 走，不是路由，所以按 'exit' 静默回收，不派发 Page.onUnload——
	 * 关掉整个小程序在微信里走的是切后台那条路。Bridge 销毁不摘 iframe DOM，退出动画照常播完。
	 */
	queueDestructionLifecycle(): void {
		if (this._destructionLifecycleQueued) {
			return
		}
		this._destructionLifecycleQueued = true
		const bridges = new Set([...this.navigator.getStack(), ...this.navigator.getTabBridges()])
		for (const bridge of bridges) {
			bridge.destroy('exit')
		}
	}

	initPageFrame(): void {
		this.el.innerHTML = tpl
	}

	// 设置指定页面状态栏的颜色模式
	updateTargetPageColorStyle(mergeConfig: { navigationBarTextStyle: string }): void {
		const { navigationBarTextStyle } = mergeConfig
		this.updateActionColorStyle(navigationBarTextStyle)
	}

	showLaunchScreen(): void {
		const launchScreen = this.el.querySelector<HTMLElement>('.dimina-mini-app__launch-screen')!
		const name = this.el.querySelector<HTMLElement>('.dimina-mini-app__name')!
		const logo = this.el.querySelector<HTMLImageElement>('.dimina-mini-app__logo-img-url')!

		this.updateActionColorStyle('black')
		name.textContent = this.appInfo.name ?? null
		logo.src = this.appInfo.logo || ''
		launchScreen.style.display = 'block'
	}

	hideLaunchScreen(): void {
		const startPage = this.el.querySelector<HTMLElement>('.dimina-mini-app__launch-screen')!
		startPage.style.display = 'none'
	}

	updateActionColorStyle(color: string | null): void {
		this.color = color
		const action = this.el.querySelector<HTMLElement>('.dimina-mini-app-navigation__actions')!

		if (color === 'white') {
			action.classList.remove('dimina-mini-app-navigation__actions--black')
			action.classList.add('dimina-mini-app-navigation__actions--white')
		}
		else if (color === 'black') {
			action.classList.remove('dimina-mini-app-navigation__actions--white')
			action.classList.add('dimina-mini-app-navigation__actions--black')
		}

		if (this.isPresentedTop()) {
			// 这是全文件唯一的状态栏配色推送出口（navigateTo/redirectTo/switchTab/
			// reLaunch/restorePageStack/initApp/showLaunchScreen/restoreColorStyle
			// 等全部经这里）；宿主 shell.updateStatusBarColor 是不可信代码，抛错
			// 不能冒充"这次呈现/切换本身失败了"，也不能让已经提交到 DOM/展示栈的
			// 结果被回滚——因此只在这一个源头统一吞掉，不需要在每个调用方分别防护。
			try {
				this.parent!.updateStatusBarColor(color!)
			}
			catch (statusBarError) {
				console.error(`[container] updateStatusBarColor threw for ${this.appId}:`, statusBarError)
			}
		}
	}

	restoreColorStyle(): void {
		this.updateActionColorStyle(this.color)
	}

	createCallbackFunction(funcId?: CallbackId): ApiCallback | undefined {
		if (funcId) {
			return (args?: unknown) => {
				this.jscore.postMessage({
					type: 'triggerCallback',
					body: {
						id: funcId,
						args,
					},
				})
			}
		}
	}

	_createApiCallbacks({ success, fail, complete }: ApiCallbackOptions = {}): { onSuccess: ApiCallback | undefined, onFail: ApiCallback | undefined, onComplete: ApiCallback | undefined } {
		const successCallback = this.createCallbackFunction(success)
		const failCallback = this.createCallbackFunction(fail)
		const completeCallback = this.createCallbackFunction(complete)
		let settledResult: unknown
		const onSuccess: ApiCallback | undefined = successCallback || completeCallback
			? (result?: unknown) => {
					settledResult = result
					successCallback?.(result)
				}
			: undefined
		const onFail: ApiCallback | undefined = failCallback || completeCallback
			? (result?: unknown) => {
					settledResult = result
					failCallback?.(result)
				}
			: undefined
		const onComplete: ApiCallback | undefined = completeCallback
			? (...args: unknown[]) => completeCallback(args.length > 0 ? args[0] : settledResult)
			: undefined
		return {
			onSuccess,
			onFail,
			onComplete,
		}
	}

	async navigateTo(opts: NavigateOptions): Promise<void> {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		// 微信规范：navigateTo 不允许跳转到 tabBar 页面
		if (this._isTabBarPage(pagePath)) {
			onFail?.({ errMsg: `navigateTo:fail can not navigateTo a tabbar page` })
			onComplete?.()
			return
		}

		// 防抖处理
		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'navigateTo:fail busy' })
			onComplete?.()
			return
		}
		this.webviewAnimaEnd = false

		// 失败回滚的快照必须在任何可能的变更之前拍下，不能事后假设 this.color
		// 还没被动过——updateTargetPageColorStyle() 之后还有多个可能抛错的步骤
		// （如 syncUrl()），任何一步失败时都得回到跳转前的原始配色，而不是
		// 半路已经被提交、但从未真正跳转成功的目标页配色。
		const previousColor = this.color

		try {
			const pageConfig = this.appConfig!.modules[pagePath]
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			// 创建新的入口页面的 bridge
			const bridge = await this.createBridge({
				pagePath,
				query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: false,
				root: pageConfig?.root || 'main',
				appId: this.appInfo.appId,
				pages: this.appConfig!.app.pages,
				configInfo: mergeConfig,
			})
			// bridge.init() 可能被并发 destroy() 打断；销毁路径上直接停止。
			if (this._destroyed) {
				return
			}

			// 更新状态栏颜色模式：必须等 bridge 真正就绪后再提交，不能在可能失败的
			// 创建之前就把配色切成目标页——否则 createBridge() reject 时配色会停留
			// 在一个从未真正跳转成功的目标页上，没有回滚。
			this.updateTargetPageColorStyle(mergeConfig)

			// 获取前一个bridge
			const preBridge = this.navigator.top!
			const preWebview = preBridge.webview!

			this.navigator.pushPage(bridge)

			// 触发新页面的初始化逻辑：新 bridge 是否可见须显式按「此刻是否仍是当前
			// 展示栈顶」算出，不能无条件可见启动——本 MiniApp 可能在异步创建期间
			// 已经被别的小程序 present 到上面，沦为后台实例。
			bridge.start({ visible: this.isPresentedTop() })
			this.safeSyncUrl()

			// 上一个页面推出
			preWebview.el.classList.remove('dimina-native-view--instage')
			preWebview.el.classList.add('dimina-native-view--slide-out')
			preWebview.el.classList.add('dimina-native-view--linear-anima')
			preBridge?.pageHide()

			this._setTabBarVisible(false)

			// 新页面推入
			bridge.webview!.el.style.zIndex = String(this.navigator.size + 1)
			bridge.webview!.el.classList.add('dimina-native-view--enter-anima')
			bridge.webview!.el.classList.add('dimina-native-view--instage')
			await waitTransitionEnd(bridge.webview!.el, 'transform')

			// 页面进入后移出动画相关class
			preWebview.el.classList.remove('dimina-native-view--linear-anima')
			bridge.webview!.el.classList.remove('dimina-native-view--before-enter')
			bridge.webview!.el.classList.remove('dimina-native-view--enter-anima')
			bridge.webview!.el.classList.remove('dimina-native-view--instage')

			onSuccess?.({ errMsg: 'navigateTo:ok' })
		}
		catch (error) {
			// 回滚必须回到调用最开始拍下的快照，而不是 this.color 当前值——失败点
			// 可能晚于 updateTargetPageColorStyle() 真正提交之后（例如后续的
			// syncUrl() 才抛错），此刻 this.color 已经是目标页配色，restoreColorStyle()
			// 只会把这个错误值再刷一遍。没有 parent 就没有宿主 shell 可推，无需尝试。
			if (this.parent) {
				try {
					this.updateActionColorStyle(previousColor)
				}
				catch {
					// 回滚配色本身失败也不能吞掉/替换原始跳转失败的原因，onFail 仍必须触发。
				}
			}
			onFail?.({ errMsg: `navigateTo:fail ${getErrorMessage(error)}` })
		}
		finally {
			this.webviewAnimaEnd = true
			onComplete?.()
		}
	}

	reLaunch(opts: NavigateOptions): void {
		const { url, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		// 防抖处理
		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'reLaunch:fail busy' })
			onComplete?.()
			return
		}
		this.webviewAnimaEnd = false

		const { query, pagePath } = queryPath(url)

		try {
			// 检查页面路径是否存在
			const pageConfig = this.appConfig!.modules[pagePath]
			// 合并页面配置
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			// 更新状态栏颜色模式
			this.updateTargetPageColorStyle(mergeConfig)

			// 销毁所有现有的 bridge：合并 stack 与 tab 池（用 Set 去重）
			const allBridges = new Set([...this.navigator.getStack(), ...this.navigator.getTabBridges()])
			for (const bridge of allBridges) {
				bridge.destroy()
				bridge.webview?.el?.remove()
			}

			// navigator 记账必须在旧 bridge 被销毁的同一刻同步清空，不能等新 bridge
			// 就绪的异步续体才收敛——否则新 bridge 创建失败时，navigator 会继续持有
			// 一批已经 destroy()、DOM 已摘除的僵尸引用，页面栈"看似非空"实为死状态。
			this.navigator.clear()

			// 地址栏必须跟着这次同步清空立刻收敛，不能只等新 bridge 就绪的异步
			// 续体里才刷新——createBridge() 之后可能 reject，届时 navigator 已经
			// 是空栈，但地址栏若不在这里同步一次，会一直停在刚被销毁的旧页面上。
			// 成功路径里 .then() 还会用新页面再调用一次 syncUrl()，这里的调用不
			// 会被它覆盖出错——syncUrl() 是纯派生，重复调用无害。
			this.safeSyncUrl()

			// 清空 webviews 容器
			if (this.webviewsContainer) {
				this.webviewsContainer.innerHTML = ''
			}

			// 创建新的入口页面的 bridge
			this.createBridge({
				pagePath,
				query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: true, // 作为根页面
				root: pageConfig?.root || 'main',
				appId: this.appInfo.appId,
				pages: this.appConfig!.app.pages,
				configInfo: mergeConfig,
			}).then((bridge) => {
				// bridge.init() 可能被并发 destroy() 打断；销毁路径上直接停止。
				if (this._destroyed) {
					return
				}

				// navigator 已经在销毁旧 bridge 的同一时刻同步清空（this.navigator.clear()
				// 见上文），这里只需要把就绪的新入口页推进去。
				this.navigator.pushPage(bridge)

				// 入口若是 tab 页：登记到 pool 并显示 TabBar
				if (this._isTabBarPage(pagePath)) {
					const normalizedPath = this._normalizePagePath(pagePath)
					this.navigator.setTabBridge(normalizedPath, bridge)
					this.navigator.setActiveTabPath(normalizedPath)
					this._setTabBarVisible(true)
					this._updateTabBarSelection(normalizedPath)
				}
				else {
					this._setTabBarVisible(false)
				}

				// 启动新页面：reLaunch() 不受 Application 那条串行 _enqueue() 队列
				// 约束（只有 presentView/dismissView 经过），异步 createBridge()
				// 在途时这个 MiniApp 完全可能已经被别的 openApp() 挤出
				// Application.views 栈顶（变成后台实例）。Bridge.start() 不传
				// visible 时，对一个全新 bridge 会缺省为可见——必须显式按
				// 「此刻是否仍是当前展示栈顶」算出可见性再传入，对齐 initApp()
				// 里 entryPageBridge.start({ visible: !isRestoringPageStack })
				// 同一条「显式算出可见性再启动」的模式，不能让新页面在后台被
				// 当成可见页启动、抢发 pageShow。
				bridge.start({ visible: this.isPresentedTop() })
				this.safeSyncUrl()

				// 设置 z-index
				bridge.webview!.el.style.zIndex = '1'

				// 恢复动画状态
				this.webviewAnimaEnd = true

				// 调用成功回调
				onSuccess?.({ errMsg: 'reLaunch:ok' })
				onComplete?.()
			}).catch((error) => {
				this.webviewAnimaEnd = true
				onFail?.({ errMsg: `reLaunch:fail ${getErrorMessage(error)}` })
				onComplete?.()
			})
		}
		catch (error) {
			onFail?.({ errMsg: `reLaunch:fail ${getErrorMessage(error)}` })
			onComplete?.()
			this.webviewAnimaEnd = true
		}
	}

	applyUpdate(): void {
		this.reLaunch({
			url: this.getEntryPagePath(),
		})
	}

	redirectTo(opts: NavigateOptions): void {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		// 微信规范：redirectTo 不允许跳转到 tabBar 页面
		if (this._isTabBarPage(pagePath)) {
			onFail?.({ errMsg: `redirectTo:fail can not redirectTo a tabbar page` })
			onComplete?.()
			return
		}

		// 防抖处理
		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'redirectTo:fail busy' })
			onComplete?.()
			return
		}
		this.webviewAnimaEnd = false

		try {
			// 获取当前 bridge
			const curBridge = this.navigator.top!
			const prevPath = this._normalizePagePath(curBridge.opts.pagePath)
			const pageConfig = this.appConfig!.modules[pagePath]
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			this.updateTargetPageColorStyle(mergeConfig)
			// 更新 bridge
			curBridge.destroy()
			curBridge.opts = {
				...curBridge.opts,
				pagePath,
				query,
				configInfo: mergeConfig,
			}
			// webview 被新页面复用：按新页面身份重刷导航栏（标题/配色/自定义导航），
			// 返回首页按钮显隐也随之重算（wx.hideHomeButton 的标记属于旧页面，不延续）
			curBridge.webview!.applyPageStyle(mergeConfig, {
				isRoot: curBridge.opts.isRoot,
				showHomeButton: this.shouldShowHomeButton({
					pagePath,
					configInfo: mergeConfig,
					isRoot: curBridge.opts.isRoot,
				}),
			})
			curBridge.resetStatus()
			curBridge.start({ visible: this.isPresentedTop() })
			this.safeSyncUrl()

			// redirectTo 的目标按规范不能是 tab 页：若被替换的是当前 tab 页，需从 pool 中移除并隐藏 TabBar
			if (this.navigator.getTabBridge(prevPath) === curBridge) {
				this.navigator.deleteTabBridge(prevPath)
				if (this.navigator.activeTabPath === prevPath) {
					this.navigator.setActiveTabPath(null)
				}
			}
			this._setBridgeTabBarInset(curBridge, false)
			this._setTabBarVisible(false)

			onSuccess?.({ errMsg: 'redirectTo:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `redirectTo:fail ${getErrorMessage(error)}` })
		}
		finally {
			this.webviewAnimaEnd = true
			onComplete?.()
		}
	}

	async navigateBack(opts: ApiCallbackOptions = {}): Promise<void> {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (this.navigator.size < 2) {
			onFail?.({ errMsg: 'navigateBack:fail cannot navigate back at first page' })
			onComplete?.()
			return
		}

		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'navigateBack:fail busy' })
			onComplete?.()
			return
		}

		this.webviewAnimaEnd = false

		try {
			const currentBridge = this.navigator.popPage()!
			const preBridge = this.navigator.top!

			const pageConfig = this.appConfig!.modules[preBridge.opts.pagePath]
			const mergeConfig = mergePageConfig(this.appConfig!.app, pageConfig)

			// 更新状态栏颜色模式
			this.updateTargetPageColorStyle(mergeConfig)

			// 当前页面推出
			currentBridge.webview!.el.classList.add('dimina-native-view--before-enter')
			currentBridge.webview!.el.classList.add('dimina-native-view--enter-anima')

			// 触发当前页面的生命周期函数
			currentBridge.destroy()

			// 上一个页面推入
			preBridge.webview!.el.classList.remove('dimina-native-view--slide-out')
			preBridge.webview!.el.classList.add('dimina-native-view--instage')
			preBridge.webview!.el.classList.add('dimina-native-view--enter-anima')

			// 触发上一个页面的生命周期函数：只有此刻仍呈现在最前时才让它变为可见页，
			// 后台实例上的返回不应抢发 pageShow。
			if (this.isPresentedTop()) {
				preBridge.pageShow()
			}
			this.safeSyncUrl()

			// 后退到 tab 页：恢复 TabBar 可见 + 选中态
			if (this._isTabBarPage(preBridge.opts.pagePath)) {
				const path = this._normalizePagePath(preBridge.opts.pagePath)
				this.navigator.setActiveTabPath(path)
				this._setTabBarVisible(true)
				this._updateTabBarSelection(path)
			}

			await waitTransitionEnd(preBridge.webview!.el, 'transform')

			// 页面进入后移出动画相关class
			preBridge.webview!.el.classList.remove('dimina-native-view--enter-anima')
			preBridge.webview!.el.classList.remove('dimina-native-view--instage')
			currentBridge.webview!.el.parentNode!.removeChild(currentBridge.webview!.el)
			onSuccess?.({ errMsg: 'navigateBack:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `navigateBack:fail ${getErrorMessage(error)}` })
		}
		finally {
			this.webviewAnimaEnd = true
			onComplete?.()
		}
	}

	/**
	 * 跳转到 tabBar 页面，并关闭其他所有非 tabBar 页面。
	 * 参考鸿蒙 DMPNavigator.switchTab + DMPTabBarContainerView 的“按需创建 + 持久缓存”模型：
	 *   1. 弹出并销毁所有非 tab 页面
	 *   2. 隐藏旧 tab 的 iframe（保留在 pool 中）
	 *   3. 目标 tab 已在 pool → 复用；否则懒加载新建并入池
	 *   4. 切换生命周期：旧 pageHide / 新 pageShow
	 *   5. 更新 TabBar 选中态、状态栏颜色、URL hash
	 */
	async switchTab(opts: NavigateOptions): Promise<void> {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const targetPath = this._normalizePagePath(pagePath)
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		if (!this._isTabBarPage(targetPath)) {
			onFail?.({ errMsg: `switchTab:fail not a tabBar page: ${targetPath}` })
			onComplete?.()
			return
		}

		// 防抖处理：避免与 navigateTo / navigateBack 动画并发
		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'switchTab:fail busy' })
			onComplete?.()
			return
		}

		// 命中当前 tab：仅更新选中态 + 显示
		if (this.navigator.activeTabPath === targetPath && this.navigator.size === 1) {
			this._setTabBarVisible(true)
			this._updateTabBarSelection(targetPath)
			onSuccess?.({ errMsg: 'switchTab:ok' })
			onComplete?.()
			return
		}

		this.webviewAnimaEnd = false

		try {
			const prevPath = this.navigator.activeTabPath
			const prevTabBridge = prevPath
				? this.navigator.getTabBridge(prevPath)
				: null
			const wasPrevTabVisible
				= !!prevTabBridge
					&& this.navigator.size === 1
					&& this.navigator.top === prevTabBridge

			// 1. 取出 / 懒加载目标 tab —— 必须在任何销毁性操作之前完成，且只依赖
			// targetPath/query/targetMergeConfig，不依赖当前栈内容。若目标 tab 未缓存、
			// createBridge() reject，下面的销毁步骤（弹出非 tab 页、摘除旧 tab）必须
			// 完全不会发生，Navigator/tab 池必须停留在调用前的原样状态。
			let targetBridge = this.navigator.getTabBridge(targetPath)
			const targetPageConfig = this.appConfig!.modules[targetPath]
			const targetMergeConfig = mergePageConfig(this.appConfig!.app, targetPageConfig)

			if (!targetBridge) {
				targetBridge = await this.createBridge({
					pagePath: targetPath,
					query,
					scene: this.appInfo.scene,
					jscore: this.jscore,
					isRoot: true,
					root: targetPageConfig?.root || 'main',
					appId: this.appInfo.appId,
					pages: this.appConfig!.app.pages,
					configInfo: targetMergeConfig,
				})
				// bridge.init() 可能被并发 destroy() 打断；销毁路径上直接停止。
				if (this._destroyed) {
					return
				}

				// bridge 一旦创建成功，必须立刻无条件登记进 tab 池并 start()，不等紧随
				// 其后的配色更新跑完才提交——updateActionColorStyle() 内部已经把
				// this.parent!.updateStatusBarColor（宿主提供）包了 try/catch，抛错
				// 不会再让这一步整体失败，但登记/start() 提前到配色更新之前依然是对的：
				// 这样"bridge 是否已创建成功"和"配色是否推送成功"两件事互不阻塞。
				this.navigator.setTabBridge(targetPath, targetBridge)
				// 立刻 start() 让它开始加载资源（避免孤儿），但显式不可见——是否真的可见
				// 由下面第 5 步统一通过 pageShow() 决定，不能在这里就假设这次切换一定会
				// 完整提交成功（配色更新等后续步骤仍可能失败）。
				targetBridge.start({ visible: false })
			}

			// 目标 bridge 已确认就绪（此刻若是新建的也已经登记+start 过）：现在才提交
			// 状态栏配色，并开始销毁旧页面。
			this.updateTargetPageColorStyle(targetMergeConfig)

			// 2. 隐藏 / 卸载非 tab 页面（从栈顶往下，遇到 tab 页停止）
			while (this.navigator.size > 0) {
				const top = this.navigator.top!
				if (this._isTabBarPage(top.opts.pagePath)) {
					break
				}
				top.pageHide()
				top.destroy()
				top.webview?.el?.remove()
				this.navigator.popPage()
			}

			// 3. 隐藏旧 tab 的 iframe（保留在 pool 中），栈顶若是旧 tab 则弹出（不销毁）
			if (
				prevTabBridge
				&& prevTabBridge !== targetBridge
			) {
				if (wasPrevTabVisible) {
					prevTabBridge.pageHide()
				}
				if (prevTabBridge.webview?.el) {
					prevTabBridge.webview.el.style.display = 'none'
				}
				this.navigator.removeFromStack(prevTabBridge)
			}

			// 4. 显示目标 tab：清理动画类、重置 z-index、display
			const targetEl = targetBridge.webview!.el
			this._setBridgeTabBarInset(targetBridge, true)
			targetEl.classList.remove(
				'dimina-native-view--before-enter',
				'dimina-native-view--slide-out',
				'dimina-native-view--enter-anima',
				'dimina-native-view--linear-anima',
				'dimina-native-view--instage',
			)
			targetEl.style.display = ''
			targetEl.style.zIndex = '1'

			// 5. 入栈（若不在），更新当前 tab，触发 pageShow：只有此刻仍呈现在最前时
			// 才让目标 tab 变为可见页，后台实例上的切换不应抢发 pageShow。
			if (!this.navigator.getStack().includes(targetBridge)) {
				this.navigator.pushPage(targetBridge)
			}
			this.navigator.setActiveTabPath(targetPath)
			if (this.isPresentedTop()) {
				targetBridge.pageShow()
			}

			// 6. UI / 状态同步
			this._setTabBarVisible(true)
			this._updateTabBarSelection(targetPath)
			this.safeSyncUrl()

			onSuccess?.({ errMsg: 'switchTab:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `switchTab:fail ${getErrorMessage(error)}` })
		}
		finally {
			this.webviewAnimaEnd = true
			onComplete?.()
		}
	}

	/**
	 * 解析并缓存 tabBar 配置；首次渲染 TabBar DOM（默认隐藏）。
	 * 后续切换仅通过 _setTabBarVisible / _updateTabBarSelection 调整，不重渲染。
	 */
	_initTabBar(): void {
		const tabBar = this.appConfig?.app?.tabBar
		if (!tabBar || !Array.isArray(tabBar.list) || tabBar.list.length === 0) {
			return
		}
		// 畸形 tabBar 项（缺 pagePath / 空串 / 非字符串）整项跳过，全部无效时视同未配置。
		// 过滤后的 list 存回 tabBarConfig，按下标的消费方与渲染使用同一份有效项。
		const validList = tabBar.list.filter(item => this._normalizePagePath(item?.pagePath) !== '')
		if (validList.length === 0) {
			return
		}
		this.tabBarConfig = { ...tabBar, list: validList }
		this.tabBarPaths = validList.map(item => this._normalizePagePath(item.pagePath))
		this.tabBarBadges = validList.map(() => '')
		this.tabBarRedDots = validList.map(() => false)
		this.tabBarApiVisible = true
		this.customTabBar = tabBar.custom === true
		if (this.customTabBar) {
			this.tabBarEl = this.el.querySelector<HTMLElement>('.dimina-mini-app__tabbar')
			if (this.tabBarEl) {
				this.tabBarEl.textContent = ''
				this.tabBarEl.style.display = 'none'
			}
			this.tabBarHeight = 0
			this.el.style.setProperty('--dimina-tabbar-height', '0px')
			return
		}
		this._renderTabBar()
	}

	/**
	 * 一次性渲染 TabBar DOM，使用事件委托处理点击。
	 */
	_renderTabBar(): void {
		this.tabBarEl = this.el.querySelector<HTMLElement>('.dimina-mini-app__tabbar')
		if (!this.tabBarEl)
			return

		const { color, backgroundColor, borderStyle, list } = this.tabBarConfig!
		const normalColor = this._sanitizeCssColor(color) || '#999999'
		const bg = this._sanitizeCssColor(backgroundColor) || '#ffffff'

		// 用 DOM API 构建，避免 innerHTML 拼接被配置中的引号 / HTML 片段污染宿主 DOM
		this.tabBarEl.textContent = ''
		const tabbar = document.createElement('div')
		tabbar.className = 'dimina-tabbar'
		tabbar.style.backgroundColor = bg
		tabbar.style.borderTopColor = this._getTabBarBorderColor(borderStyle)

		list.forEach((item, index) => {
			const path = this._normalizePagePath(item.pagePath)

			const itemEl = document.createElement('div')
			itemEl.className = 'dimina-tabbar-item'
			itemEl.dataset.path = path
			itemEl.dataset.index = String(index)

			const defaultIconUrl = this._resolveTabBarIcon(item.iconPath)
			if (defaultIconUrl) {
				itemEl.appendChild(this._createTabBarIcon(defaultIconUrl, 'dimina-tabbar-icon-default'))
			}
			const selectedIconUrl = this._resolveTabBarIcon(item.selectedIconPath)
			if (selectedIconUrl) {
				itemEl.appendChild(this._createTabBarIcon(selectedIconUrl, 'dimina-tabbar-icon-selected'))
			}

			const text = document.createElement('span')
			text.className = 'dimina-tabbar-text'
			text.style.color = normalColor
			text.textContent = item.text || ''
			itemEl.appendChild(text)

			const badge = document.createElement('span')
			badge.className = 'dimina-tabbar-badge'
			badge.hidden = true
			itemEl.appendChild(badge)

			const redDot = document.createElement('span')
			redDot.className = 'dimina-tabbar-red-dot'
			redDot.hidden = true
			itemEl.appendChild(redDot)

			tabbar.appendChild(itemEl)
		})

		this.tabBarEl.appendChild(tabbar)

		// 事件委托：单一监听器处理所有 tab 项点击
		this.tabBarEl.addEventListener('click', (e) => {
			const item = (e.target as HTMLElement).closest<HTMLElement>('.dimina-tabbar-item')
			if (!item)
				return
			const path = item.dataset.path
			if (path && path !== this.navigator.activeTabPath) {
				this.switchTab({ url: `/${path}` })
			}
		})

		// 监听 TabBar 实际高度（含 safe-area-inset-bottom）变化，
		// 并同步到所有 tab 页 webview，避免硬编码与样式漂移
		if (typeof ResizeObserver !== 'undefined') {
			this._tabBarResizeObserver?.disconnect()
			this._tabBarResizeObserver = new ResizeObserver(() => this._syncTabBarHeightVar())
			this._tabBarResizeObserver.observe(this.tabBarEl)
		}
	}

	/**
	 * 创建一张 tabBar 图标 <img>，带加载失败兜底（隐藏，避免破图占位）。
	 */
	_createTabBarIcon(src: string, modifierClass: string): HTMLImageElement {
		const img = document.createElement('img')
		img.className = `dimina-tabbar-icon ${modifierClass}`
		img.src = src
		img.alt = ''
		img.addEventListener('error', () => {
			img.style.display = 'none'
		})
		return img
	}

	/**
	 * 简单 CSS 颜色白名单：#hex / rgb(a)/hsl(a)/常见关键字。
	 * 拒绝包含尖括号、引号、分号、url() 等可能逃逸 style 上下文的字符；
	 * 不命中白名单时返回空串，让调用方走默认色。
	 */
	_sanitizeCssColor(value?: string | null): string {
		if (!value || typeof value !== 'string')
			return ''
		const v = value.trim()
		if (v.length === 0 || v.length > 64)
			return ''
		// 任意 url()/expression()/HTML 注入尝试都会包含下面的字符
		if (/[<>"';{}()\\]/.test(v)) {
			// 兼容 rgb(a)/hsl(a) 函数：仅放行严格匹配的形态
			if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/-]+\)$/i.test(v)) {
				return v
			}
			return ''
		}
		return v
	}

	_getTabBarBorderColor(borderStyle?: string): string {
		return borderStyle === 'white' ? '#ffffff' : '#e0e0e0'
	}

	/**
	 * 获取 TabBar 实际高度。隐藏状态下临时不可见测量一次，避免首次 switchTab
	 * 到 tab 页时缺少底部留白。
	 */
	_getTabBarHeight(): number {
		if (this.customTabBar)
			return 0
		if (!this.tabBarEl)
			return this.tabBarHeight

		let height = this.tabBarEl.getBoundingClientRect().height
		if (!height && this.tabBarEl.style.display === 'none') {
			const oldDisplay = this.tabBarEl.style.display
			const oldVisibility = this.tabBarEl.style.visibility

			this.tabBarEl.style.visibility = 'hidden'
			this.tabBarEl.style.display = 'block'
			height = this.tabBarEl.getBoundingClientRect().height
			this.tabBarEl.style.display = oldDisplay
			this.tabBarEl.style.visibility = oldVisibility
		}

		if (height > 0) {
			this.tabBarHeight = height
		}
		return this.tabBarHeight
	}

	/**
	 * 把 TabBar 当前实际高度同步到 CSS 变量和 tab 页 webview。
	 * webviews 容器保持全屏，只有 tab 页自身预留底部空间；这样隐藏
	 * tabbar 跳转到非 tab 页时，不会触发所有页面整体重排。
	 */
	_syncTabBarHeightVar(): void {
		const height = this._getTabBarHeight()
		this.el.style.setProperty('--dimina-tabbar-height', `${height}px`)
		this._syncTabBarBridgeInsets()
	}

	_setBridgeTabBarInset(bridge: Bridge | undefined | null, enabled: boolean): void {
		const webviewEl = bridge?.webview?.el
		if (!webviewEl)
			return

		if (!enabled || this.customTabBar) {
			webviewEl.style.removeProperty('bottom')
			return
		}

		webviewEl.style.bottom = `${this._getTabBarHeight()}px`
	}

	_syncTabBarBridgeInsets(): void {
		for (const bridge of this.navigator.getTabBridges()) {
			this._setBridgeTabBarInset(bridge, true)
		}
	}

	_joinBaseUrl(...segments: unknown[]): string {
		// getResourceBaseUrl() 已由 Application 归一化为带结尾斜杠的字符串。
		const normalizedBaseUrl = this.getResourceBaseUrl()
		const path = segments
			.map(segment => String(segment).trim().replace(/^\/+|\/+$/g, ''))
			.filter(Boolean)
			.join('/')
		return `${normalizedBaseUrl}${path}`
	}

	/**
	 * 解析 tabBar 图标路径。
	 * 编译期 collectAssets 会输出 appId/main/static/...，本地源路径则按小程序
	 * 根目录兜底到 appId/main/...，两类路径都统一挂到 resourceBaseUrl 下。
	 */
	_resolveTabBarIcon(iconPath?: string | null): string | null {
		if (!iconPath || typeof iconPath !== 'string')
			return null

		const rawPath = iconPath.trim()
		if (!rawPath)
			return null

		// 已是完整 URL / data 协议 / 协议无关路径：保持原值
		if (/^(?:data:|blob:|https?:|\/\/)/i.test(rawPath)) {
			return rawPath
		}

		const localPath = rawPath.replace(/^\/+/, '').replace(/^\.\//, '')
		const appRootPrefix = `${this.appId}/`
		if (localPath.startsWith(appRootPrefix)) {
			return this._joinBaseUrl(localPath)
		}

		// 兜底：用户配置里仍是包内相对路径（未走 collectAssets 改写或拷贝失败）
		return this._joinBaseUrl(this.appId, 'main', localPath)
	}

	/**
	 * 控制 TabBar 容器的显示/隐藏。底部留白只作用在 tab 页 webview 上，
	 * 避免非 tab 跳转过程中改变 webviews 容器高度。
	 */
	_setTabBarVisible(visible: boolean): void {
		if (!this.tabBarEl)
			return
		if (this.customTabBar) {
			this.tabBarEl.style.display = 'none'
			this._syncTabBarHeightVar()
			return
		}
		const topBridge = this.navigator.top
		const topPath = this._normalizePagePath(topBridge?.opts?.pagePath)
		const isTopTabPage = !!topPath && topPath === this.navigator.activeTabPath && this._isTabBarPage(topPath)
		const shouldDisplay = visible && this.tabBarApiVisible && isTopTabPage
		this.tabBarEl.style.display = shouldDisplay ? 'block' : 'none'
		// display 切换通常不会触发 ResizeObserver，主动同步一次
		this._syncTabBarHeightVar()
	}

	/**
	 * 仅更新 TabBar 选中态（颜色 / 图标 / class），不重渲染。
	 */
	_updateTabBarSelection(currentPath: string | null): void {
		if (!this.tabBarEl || !this.tabBarConfig)
			return
		const normalColor = this.tabBarConfig.color || '#999999'
		const selectedColor = this.tabBarConfig.selectedColor || '#1890ff'

		this.tabBarEl.querySelectorAll<HTMLElement>('.dimina-tabbar-item').forEach((item) => {
			const path = item.getAttribute('data-path')
			const isSelected = path === currentPath
			const text = item.querySelector<HTMLElement>('.dimina-tabbar-text')
			const defaultIcon = item.querySelector<HTMLElement>('.dimina-tabbar-icon-default')
			const selectedIcon = item.querySelector<HTMLElement>('.dimina-tabbar-icon-selected')

			if (text)
				text.style.color = isSelected ? selectedColor : normalColor
			if (defaultIcon)
				defaultIcon.style.display = isSelected ? 'none' : 'block'
			if (selectedIcon)
				selectedIcon.style.display = isSelected ? 'block' : 'none'
			item.classList.toggle('dimina-tabbar-item--selected', isSelected)
		})
	}

	_getTabBarItemEl(index: number): HTMLElement | null {
		return this.tabBarEl?.querySelector<HTMLElement>(`.dimina-tabbar-item[data-index="${index}"]`) || null
	}

	_validateTabBarIndex(apiName: string, index: number | string | undefined, onFail: ApiCallback | undefined, onComplete: ApiCallback | undefined): boolean {
		const listLength = this.tabBarConfig?.list?.length || 0
		if (!listLength || !this.tabBarEl) {
			onFail?.({ errMsg: `${apiName}:fail tabBar not configured` })
			onComplete?.()
			return false
		}
		const normalizedIndex = Number(index)
		if (index === undefined || index === null || !Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= listLength) {
			onFail?.({ errMsg: `${apiName}:fail invalid index ${index}` })
			onComplete?.()
			return false
		}
		return true
	}

	_replaceTabBarItemIcons(itemEl: HTMLElement, item: TabBarItemConfig): void {
		const textEl = itemEl.querySelector<HTMLElement>('.dimina-tabbar-text')
		itemEl.querySelectorAll('.dimina-tabbar-icon-default, .dimina-tabbar-icon-selected')
			.forEach(icon => icon.remove())

		const defaultIconUrl = this._resolveTabBarIcon(item.iconPath)
		if (defaultIconUrl) {
			itemEl.insertBefore(
				this._createTabBarIcon(defaultIconUrl, 'dimina-tabbar-icon-default'),
				textEl,
			)
		}

		const selectedIconUrl = this._resolveTabBarIcon(item.selectedIconPath)
		if (selectedIconUrl) {
			itemEl.insertBefore(
				this._createTabBarIcon(selectedIconUrl, 'dimina-tabbar-icon-selected'),
				textEl,
			)
		}
	}

	/**
	 * wx.setTabBarStyle：原地更新 tabBarConfig 与已渲染 DOM，不重建 tabbar，
	 * 保留事件绑定 / 图标 / 选中态。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.setTabBarStyle.html
	 */
	setTabBarStyle(opts: SetTabBarStyleOptions = {}): void {
		const { color, selectedColor, backgroundColor, borderStyle, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		if (!this.tabBarConfig || !this.tabBarEl) {
			onFail?.({ errMsg: 'setTabBarStyle:fail tabBar not configured' })
			onComplete?.()
			return
		}

		const validBorderStyle = borderStyle === 'black' || borderStyle === 'white' ? borderStyle : null

		const safeColor = color !== undefined ? this._sanitizeCssColor(color) : null
		const safeSelectedColor = selectedColor !== undefined ? this._sanitizeCssColor(selectedColor) : null
		const safeBg = backgroundColor !== undefined ? this._sanitizeCssColor(backgroundColor) : null

		// 1. 更新缓存 config —— 后续 _updateTabBarSelection / _renderTabBar 都依赖它
		if (safeColor)
			this.tabBarConfig.color = safeColor
		if (safeSelectedColor)
			this.tabBarConfig.selectedColor = safeSelectedColor
		if (safeBg)
			this.tabBarConfig.backgroundColor = safeBg
		if (validBorderStyle)
			this.tabBarConfig.borderStyle = validBorderStyle

		// 2. 更新已渲染的 tabbar DOM（背景 / 边框）
		const tabbar = this.tabBarEl.querySelector<HTMLElement>('.dimina-tabbar')
		if (tabbar) {
			if (safeBg)
				tabbar.style.backgroundColor = safeBg
			if (validBorderStyle)
				tabbar.style.borderTopColor = this._getTabBarBorderColor(validBorderStyle)
		}

		// 3. 文字颜色按当前选中态重新刷一遍（同时处理 color 和 selectedColor）
		this._updateTabBarSelection(this.navigator.activeTabPath)

		onSuccess?.({ errMsg: 'setTabBarStyle:ok' })
		onComplete?.()
	}

	setTabBarItem(opts: SetTabBarItemOptions = {}): void {
		const { index, text, iconPath, selectedIconPath } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!this._validateTabBarIndex('setTabBarItem', index, onFail, onComplete)) {
			return
		}

		const tabIndex = Number(index)
		const oldItem = this.tabBarConfig!.list[tabIndex]
		const newItem: TabBarItemConfig = {
			...oldItem,
			text: text !== undefined ? text : oldItem.text,
			iconPath: iconPath !== undefined ? iconPath : oldItem.iconPath,
			selectedIconPath: selectedIconPath !== undefined ? selectedIconPath : oldItem.selectedIconPath,
		}
		this.tabBarConfig!.list[tabIndex] = newItem

		const itemEl = this._getTabBarItemEl(tabIndex)
		if (itemEl) {
			const textEl = itemEl.querySelector<HTMLElement>('.dimina-tabbar-text')
			if (textEl)
				textEl.textContent = newItem.text || ''
			if (iconPath !== undefined || selectedIconPath !== undefined) {
				this._replaceTabBarItemIcons(itemEl, newItem)
			}
			this._updateTabBarSelection(this.navigator.activeTabPath)
		}

		onSuccess?.({ errMsg: 'setTabBarItem:ok' })
		onComplete?.()
	}

	showTabBar(opts: ApiCallbackOptions = {}): void {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		this.tabBarApiVisible = true
		this._setTabBarVisible(true)
		onSuccess?.({ errMsg: 'showTabBar:ok' })
		onComplete?.()
	}

	hideTabBar(opts: ApiCallbackOptions = {}): void {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		this.tabBarApiVisible = false
		this._setTabBarVisible(false)
		onSuccess?.({ errMsg: 'hideTabBar:ok' })
		onComplete?.()
	}

	setTabBarBadge(opts: TabBarBadgeOptions = {}): void {
		const { index, text = '' } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!this._validateTabBarIndex('setTabBarBadge', index, onFail, onComplete)) {
			return
		}

		const tabIndex = Number(index)
		this.tabBarBadges[tabIndex] = String(text)
		this.tabBarRedDots[tabIndex] = false
		const itemEl = this._getTabBarItemEl(tabIndex)
		const badgeEl = itemEl?.querySelector<HTMLElement>('.dimina-tabbar-badge')
		const redDotEl = itemEl?.querySelector<HTMLElement>('.dimina-tabbar-red-dot')
		if (badgeEl) {
			badgeEl.textContent = this.tabBarBadges[tabIndex]
			badgeEl.hidden = this.tabBarBadges[tabIndex].length === 0
		}
		if (redDotEl)
			redDotEl.hidden = true

		onSuccess?.({ errMsg: 'setTabBarBadge:ok' })
		onComplete?.()
	}

	removeTabBarBadge(opts: TabBarIndexOptions = {}): void {
		const { index } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!this._validateTabBarIndex('removeTabBarBadge', index, onFail, onComplete)) {
			return
		}

		const tabIndex = Number(index)
		this.tabBarBadges[tabIndex] = ''
		const badgeEl = this._getTabBarItemEl(tabIndex)?.querySelector<HTMLElement>('.dimina-tabbar-badge')
		if (badgeEl) {
			badgeEl.textContent = ''
			badgeEl.hidden = true
		}

		onSuccess?.({ errMsg: 'removeTabBarBadge:ok' })
		onComplete?.()
	}

	showTabBarRedDot(opts: TabBarIndexOptions = {}): void {
		const { index } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!this._validateTabBarIndex('showTabBarRedDot', index, onFail, onComplete)) {
			return
		}

		const tabIndex = Number(index)
		this.tabBarRedDots[tabIndex] = true
		this.tabBarBadges[tabIndex] = ''
		const itemEl = this._getTabBarItemEl(tabIndex)
		const badgeEl = itemEl?.querySelector<HTMLElement>('.dimina-tabbar-badge')
		const redDotEl = itemEl?.querySelector<HTMLElement>('.dimina-tabbar-red-dot')
		if (badgeEl) {
			badgeEl.textContent = ''
			badgeEl.hidden = true
		}
		if (redDotEl)
			redDotEl.hidden = false

		onSuccess?.({ errMsg: 'showTabBarRedDot:ok' })
		onComplete?.()
	}

	hideTabBarRedDot(opts: TabBarIndexOptions = {}): void {
		const { index } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!this._validateTabBarIndex('hideTabBarRedDot', index, onFail, onComplete)) {
			return
		}

		const tabIndex = Number(index)
		this.tabBarRedDots[tabIndex] = false
		const redDotEl = this._getTabBarItemEl(tabIndex)?.querySelector<HTMLElement>('.dimina-tabbar-red-dot')
		if (redDotEl)
			redDotEl.hidden = true

		onSuccess?.({ errMsg: 'hideTabBarRedDot:ok' })
		onComplete?.()
	}

	async navigateToMiniProgram(opts: NavigateToMiniProgramOptions = {}): Promise<void> {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		try {
			await this.parent!.appManager.navigateToMiniProgram(opts, this)
			const result = { errMsg: 'navigateToMiniProgram:ok' }
			onSuccess?.(result)
			onComplete?.(result)
		}
		catch (error) {
			const result = { errMsg: `navigateToMiniProgram:fail ${getErrorMessage(error)}` }
			onFail?.(result)
			onComplete?.(result)
		}
	}

	async navigateBackMiniProgram(opts: NavigateBackMiniProgramOptions = {}): Promise<void> {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		let committed = false
		try {
			await this.parent!.appManager.navigateBackMiniProgram(this, opts.extraData, async () => {
				committed = true
				const result = { errMsg: 'navigateBackMiniProgram:ok' }
				onSuccess?.(result)
				onComplete?.(result)
			})
		}
		catch (error) {
			if (!committed) {
				const result = { errMsg: `navigateBackMiniProgram:fail ${getErrorMessage(error)}` }
				onFail?.(result)
				onComplete?.(result)
			}
		}
	}

	async exitMiniProgram(opts: ApiCallbackOptions = {}): Promise<void> {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		let committed = false
		try {
			await this.parent!.appManager.exitMiniProgram(this, async () => {
				committed = true
				const result = { errMsg: 'exitMiniProgram:ok' }
				onSuccess?.(result)
				onComplete?.(result)
			})
		}
		catch (error) {
			if (!committed) {
				const result = { errMsg: `exitMiniProgram:fail ${getErrorMessage(error)}` }
				onFail?.(result)
				onComplete?.(result)
			}
		}
	}

	async restartMiniProgram(opts: RestartMiniProgramOptions = {}): Promise<void> {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		let committed = false
		try {
			await this.parent!.appManager.restartMiniProgram(this, opts.path ?? '', async () => {
				committed = true
				const result = { errMsg: 'restartMiniProgram:ok' }
				onSuccess?.(result)
				onComplete?.(result)
			})
		}
		catch (error) {
			if (!committed) {
				const result = { errMsg: `restartMiniProgram:fail ${getErrorMessage(error)}` }
				onFail?.(result)
				onComplete?.(result)
			}
		}
	}

	bindMoreEvent(): void {
		const moreBtn = this.el.querySelector<HTMLElement>('.dimina-mini-app-navigation__actions-variable')!
		const overlay = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__mask')!
		const menu = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu')!
		const cancelBtn = this.el.querySelector<HTMLElement>('.dimina-mini-app-menu__footer-btn--cancel')!

		overlay.addEventListener('transitionend', () => {
			if (!overlay.classList.contains('show')) {
				overlay.style.display = 'none'
			}
		})

		moreBtn.onclick = () => this.openMiniAppMenu()
		overlay.onclick = () => this.closeMiniAppMenu()
		cancelBtn.onclick = () => this.closeMiniAppMenu()
		menu.onclick = e => e.stopPropagation()
	}

	bindCloseEvent(): void {
		const closeBtn = this.el.querySelector<HTMLElement>('.dimina-mini-app-navigation__actions-close')!

		closeBtn.onclick = () => {
			this.closeMiniProgram()
		}
	}

	destroy(): void {
		this._destroyed = true
		// Destructive APIs call this before their flush barrier. Keep this idempotent fallback for
		// non-API cleanup paths so Bridge-owned resources are never silently skipped.
		this.queueDestructionLifecycle()
		// 打断在途的 bridge.init()：不再等一个必然不会触发 load 的 iframe 握手。
		this._destroyAbortController.abort()
		this.webSocketManager.destroy()

		let extUnsubscribeError: unknown
		for (const unsubscribe of this._extSubscriptions.values()) {
			try {
				unsubscribe?.()
			}
			catch (unsubscribeError) {
				// 扩展模块的 unsubscribe 是宿主/第三方代码；单个失败不能挡住其它
				// unsubscribe 的执行，也不能挡住 destroy() 后续的资源回收
				// （尤其是 jscore worker 终止和 AppManager 登记表摘除）。第一个
				// 抛出的错误记下来，等收尾全部跑完之后再抛给调用方，让调用方仍能
				// 感知到这次 destroy() 并不干净。
				console.error(`[container] extension unsubscribe threw during destroy() for ${this.appId}:`, unsubscribeError)
				if (!extUnsubscribeError) {
					extUnsubscribeError = unsubscribeError
				}
			}
		}
		this._extSubscriptions.clear()
		for (const handler of this._windowResizeHandlers) {
			globalThis.removeEventListener?.('resize', handler)
		}
		this._windowResizeHandlers.clear()
		for (const handler of this._networkStatusHandlers.values()) {
			globalThis.removeEventListener?.('online', handler)
			globalThis.removeEventListener?.('offline', handler)
			this._networkConnection()?.removeEventListener?.('change', handler)
		}
		this._networkStatusHandlers.clear()
		this._keepScreenOnRequested = false
		if (this._wakeLockVisibilityHandler) {
			document.removeEventListener('visibilitychange', this._wakeLockVisibilityHandler)
			this._wakeLockVisibilityHandler = null
		}
		void this._releaseWakeLock().catch(() => {})
		this._mediaPreviewEl?.remove()
		this._mediaPreviewEl = null
		for (const url of this._tempObjectUrls) URL.revokeObjectURL(url)
		this._tempObjectUrls.clear()
		if (this._themeMediaQuery?.removeEventListener) {
			this._themeMediaQuery.removeEventListener('change', this._themeChangeHandler!)
		}
		else {
			this._themeMediaQuery?.removeListener?.(this._themeChangeHandler as unknown as (this: MediaQueryList, ev: MediaQueryListEvent) => void)
		}
		this._themeMediaQuery = null
		this._themeChangeHandler = null

		this._tabBarResizeObserver?.disconnect()
		this._tabBarResizeObserver = null

		for (const t of this._modalPendingTimers) clearTimeout(t)
		this._modalPendingTimers.clear()

		for (const entry of this._modalStack) {
			entry.mask?.remove()
			entry.dialog?.remove()
		}
		this._modalStack.length = 0
		this._unlockModalPageTouch()

		this.hideToast({})

		this.parent?.appManager?.removeApp(this)
		this.jscore.destroy()

		if (extUnsubscribeError) {
			// 原样抛回扩展抛出的值。包成 Error 会把非 Error 的对象压成
			// "[object Object]"，调用方就没法再按自己的类型判断了。
			// eslint-disable-next-line no-throw-literal
			throw extUnsubscribeError
		}
	}

	connectSocket(opts: ApiParams = {}): void {
		this.webSocketManager.connectSocket(opts)
	}

	sendSocketMessage(opts: ApiParams = {}): void {
		this.webSocketManager.sendSocketMessage(opts)
	}

	closeSocket(opts: ApiParams = {}): void {
		this.webSocketManager.closeSocket(opts)
	}

	onSocketOpen(opts: ApiParams = {}): void {
		this.onSocketEvent('open', opts)
	}

	onSocketMessage(opts: ApiParams = {}): void {
		this.onSocketEvent('message', opts)
	}

	onSocketError(opts: ApiParams = {}): void {
		this.onSocketEvent('error', opts)
	}

	onSocketClose(opts: ApiParams = {}): void {
		this.onSocketEvent('close', opts)
	}

	offSocketOpen(opts: ApiParams = {}): void {
		this.offSocketEvent('open', opts)
	}

	offSocketMessage(opts: ApiParams = {}): void {
		this.offSocketEvent('message', opts)
	}

	offSocketError(opts: ApiParams = {}): void {
		this.offSocketEvent('error', opts)
	}

	offSocketClose(opts: ApiParams = {}): void {
		this.offSocketEvent('close', opts)
	}

	private onSocketEvent(event: SocketEventName, opts: ApiParams): void {
		this.webSocketManager.onSocketEvent(event, opts)
	}

	private offSocketEvent(event: SocketEventName, opts: ApiParams): void {
		this.webSocketManager.offSocketEvent(event, opts)
	}

	/**
	 * 获取网络类型
	 * https://developers.weixin.qq.com/miniprogram/dev/api/device/network/wx.getNetworkType.html
	 */
	getNetworkType(opts: ApiCallbackOptions): void {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		const result = { networkType: this._currentNetworkType(), errMsg: 'getNetworkType:ok' }
		onSuccess?.(result)
		onComplete?.(result)
	}

	onNetworkStatusChange(opts: ApiCallbackOptions & { callbackId?: CallbackId }): void {
		const callbackId = opts.callbackId ?? opts.success
		if (!callbackId || this._networkStatusHandlers.has(callbackId)) return
		const onChange = () => {
			this.createCallbackFunction(callbackId)?.({
				isConnected: navigator.onLine,
				networkType: this._currentNetworkType(),
			})
		}
		this._networkStatusHandlers.set(callbackId, onChange)
		globalThis.addEventListener?.('online', onChange)
		globalThis.addEventListener?.('offline', onChange)
		this._networkConnection()?.addEventListener?.('change', onChange)
	}

	offNetworkStatusChange(opts: { callbackId?: CallbackId } = {}): void {
		const entries = opts.callbackId
			? [[opts.callbackId, this._networkStatusHandlers.get(opts.callbackId)] as const]
			: [...this._networkStatusHandlers.entries()]
		for (const [callbackId, handler] of entries) {
			if (!handler) continue
			globalThis.removeEventListener?.('online', handler)
			globalThis.removeEventListener?.('offline', handler)
			this._networkConnection()?.removeEventListener?.('change', handler)
			this._networkStatusHandlers.delete(callbackId)
		}
	}

	private _networkConnection(): NetworkInformationLike | undefined {
		const currentNavigator = navigator as unknown as NavigatorWithDeviceApis
		return currentNavigator.connection ?? currentNavigator.mozConnection ?? currentNavigator.webkitConnection
	}

	private _currentNetworkType(): string {
		if (!navigator.onLine) return 'none'
		const connection = this._networkConnection()
		const type = connection?.type?.toLowerCase()
		if (type === 'wifi' || type === 'ethernet') return 'wifi'
		if (type === 'cellular') {
			const effectiveType = connection?.effectiveType?.toLowerCase()
			if (effectiveType && ['2g', '3g', '4g', '5g'].includes(effectiveType)) return effectiveType
		}
		return 'unknown'
	}

	getSystemInfoAsync(opts: ApiCallbackOptions): void {
		const bar = this._getStatusBarRect()
		const wb = this.parent!.el.querySelector<HTMLElement>('.dimina-native-webview__root')!.getBoundingClientRect()

		const { success, complete } = opts

		const { onSuccess, onComplete } = this._createApiCallbacks({ success, complete })

		onSuccess?.({
			statusBarHeight: bar.height,
			brand: 'devtools',
			mode: 'default',
			model: 'web',
			platform: 'devtools',
			system: 'web',
			deviceOrientation: 'portrait',
			SDKVersion: '3.0.0',
			language: 'zh_CN',
			wifiEnabled: true,
			safeArea: {
				width: wb.width,
				height: wb.height,
				top: wb.top,
				bottom: wb.bottom,
				left: wb.left,
				right: wb.right,
			},
		})
		onComplete?.()
	}

	getSystemInfo(opts: ApiCallbackOptions = {}): void {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		onSuccess?.({
			...this.getSystemInfoSync(),
			errMsg: 'getSystemInfo:ok',
		})
		onComplete?.()
	}

	onWindowResize(opts: { success?: CallbackId } = {}): void {
		const onResize = this.createCallbackFunction(opts.success)
		if (!onResize || !globalThis.addEventListener) {
			return
		}

		const handler = () => {
			const { windowWidth, windowHeight, deviceOrientation = 'portrait' } = this.getSystemInfoSync()
			onResize({
				size: { windowWidth, windowHeight },
				deviceOrientation,
			})
		}
		this._windowResizeHandlers ??= new Set()
		this._windowResizeHandlers.add(handler)
		globalThis.addEventListener('resize', handler)
	}

	getMenuButtonBoundingClientRect() {
		const rect = this.el.querySelector<HTMLElement>('.dimina-mini-app-navigation__actions')!.getBoundingClientRect()
		const appRect = this.el.getBoundingClientRect()
		const statusBarHeight = this._getStatusBarRect().height || 0
		// 对齐到小程序导航栏的几何模型：
		// navbar 总高约等于 statusBarHeight + 40px，胶囊在内容区内垂直居中
		const normalizedTop = statusBarHeight + 4
		const normalizedBottom = normalizedTop + rect.height
		// getBoundingClientRect() 返回的是宿主页面坐标，而小程序 API 约定返回
		// 当前小程序视口坐标。容器不在页面原点时必须扣除自身偏移，否则
		// navbar 会用宿主坐标计算中心区域，把标题推到屏幕边缘。
		const normalizedLeft = rect.left - appRect.left
		const normalizedRight = rect.right - appRect.left
		return {
			top: normalizedTop,
			right: normalizedRight,
			bottom: normalizedBottom,
			left: normalizedLeft,
			width: rect.width,
			height: rect.height,
			x: normalizedLeft,
			y: normalizedTop,
		}
	}

	getHostEnvSnapshot() {
		return {
			menuRect: this.getMenuButtonBoundingClientRect(),
			systemInfo: this.getSystemInfoSync(),
		}
	}

	_bindThemeChange(): void {
		const mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
		if (!mediaQuery) {
			return
		}
		this._themeMediaQuery = mediaQuery
		this._themeChangeHandler = (event: MediaQueryListEvent) => {
			this.jscore.postMessage({
				type: 'hostEnvUpdate',
				body: {
					systemInfo: {
						...this.getSystemInfoSync(),
						theme: event.matches ? 'dark' : 'light',
					},
				},
			})
		}
		if (mediaQuery.addEventListener) {
			mediaQuery.addEventListener('change', this._themeChangeHandler)
		}
		else {
			mediaQuery.addListener?.(this._themeChangeHandler as unknown as (this: MediaQueryList, ev: MediaQueryListEvent) => void)
		}
	}

	getSystemInfoSync() {
		const viewport = this.parent!.el.querySelector<HTMLElement>('.dimina-native-webview__root')
		const viewportRect = viewport?.getBoundingClientRect()
		// getBoundingClientRect() 会包含宿主舞台的 CSS transform。在桌面端按比例
		// 缩放设备预览时，它返回的是屏幕上的视觉尺寸，而小游戏事件坐标仍属于
		// iframe 的逻辑视口。优先使用布局尺寸，确保 wx.getSystemInfoSync()、
		// wx.createCanvas() 和浏览器输入事件处于同一个坐标系。
		const width = viewport?.clientWidth || viewportRect?.width || this.el.clientWidth || 375
		const height = viewport?.clientHeight || viewportRect?.height || this.el.clientHeight || 667
		const statusBarHeight = this._getStatusBarRect().height || 0

		return {
			brand: 'devtools',
			model: 'web',
			platform: 'devtools',
			system: 'web',
			SDKVersion: '3.0.0', // vant组件库 判断  canIUseModel version 需要大于 2.9.3
			pixelRatio: globalThis.devicePixelRatio || 1,
			screenWidth: width,
			screenHeight: height,
			windowWidth: width,
			windowHeight: height,
			statusBarHeight,
			safeArea: {
				left: 0,
				right: width,
				top: statusBarHeight,
				bottom: height,
				width,
				height: Math.max(height - statusBarHeight, 0),
			},
			enableDebug: false,
			host: { appId: '' },
			language: navigator.language || 'zh_CN',
			version: '',
			theme: globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light',
			fontSizeScaleFactor: 1,
			fontSizeSetting: 16,
			deviceOrientation: 'portrait' as const,
		}
	}

	showToast(opts: ShowToastOptions = {}): void {
		const { title = '', duration = 1500, icon = 'success', mask = false, success, complete } = opts

		if (!title) {
			return
		}

		this.hideToast({})

		const { onSuccess, onComplete } = this._createApiCallbacks({ success, complete })

		// 可选遮罩层：mask:true 时阻止用户点击下层内容（对齐 wx.showToast）
		let maskEl: HTMLElement | null = null
		if (mask) {
			maskEl = document.createElement('div')
			maskEl.className = 'dimina-toast-mask'
			this.el.appendChild(maskEl)
		}

		const dom = document.createElement('div')
		dom.className = `dimina-toast dimina-toast--${icon}`
		// 没图标的 toast（icon: 'none'）：只渲染文本，不再占 120x120 大方块
		if (icon === 'none') {
			dom.classList.add('dimina-toast--text-only')
		}
		const p = document.createElement('p')
		p.textContent = String(title)
		dom.appendChild(p)

		// 挂到 mini-app 根节点，避免被 webviewsContainer 的页面层级裁剪 / 遮挡
		this.el.appendChild(dom)
		this.toastInfo.dom = dom
		this.toastInfo.maskEl = maskEl

		this.toastInfo.timer = setTimeout(() => {
			dom.remove()
			maskEl?.remove()
			if (this.toastInfo.dom === dom) {
				this.toastInfo.dom = null
				this.toastInfo.maskEl = null
				this.toastInfo.timer = null
			}
		}, duration)

		onSuccess?.()
		onComplete?.()
	}

	hideToast(opts: ApiCallbackOptions = {}): void {
		const { success, complete } = opts
		const { onSuccess, onComplete } = this._createApiCallbacks({ success, complete })

		if (this.toastInfo.dom) {
			this.toastInfo.dom.remove()
			this.toastInfo.dom = null
		}
		if (this.toastInfo.maskEl) {
			this.toastInfo.maskEl.remove()
			this.toastInfo.maskEl = null
		}
		if (this.toastInfo.timer) {
			clearTimeout(this.toastInfo.timer)
			this.toastInfo.timer = null
		}
		onSuccess?.()
		onComplete?.()
	}

	showLoading(opts: Omit<ShowToastOptions, 'icon'> = {}): void {
		this.showToast({ ...opts, icon: 'loading' })
	}

	hideLoading(opts: ApiCallbackOptions = {}): void {
		this.hideToast(opts)
	}

	/** 把当前顶层页面 iframe 的 touchmove 吞掉：modal 打开期间不让底层页面跟手滚动/手势穿透。 */
	_lockModalPageTouch(): void {
		if (this._modalPageTouchTarget)
			return
		const currentBridge = this.navigator.top
		const pageWindow = currentBridge?.webview?.iframe?.contentWindow
		if (!pageWindow?.addEventListener)
			return

		pageWindow.addEventListener('touchmove', blockModalPageTouchMove, {
			capture: true,
			passive: false,
		})
		this._modalPageTouchTarget = pageWindow
	}

	_unlockModalPageTouch(): void {
		if (!this._modalPageTouchTarget)
			return
		this._modalPageTouchTarget.removeEventListener(
			'touchmove',
			blockModalPageTouchMove,
			true,
		)
		this._modalPageTouchTarget = null
	}

	showModal(opts: ShowModalOptions): void {
		if (this._destroyed)
			return
		if (this._modalStack.length === 0) {
			// 当前 touch stream 仍以 iframe 内元素为 target；外层 mask 无法接管已开始的手势。
			this._lockModalPageTouch()
		}
		const entry = this._mountModal(opts || {})
		this._modalStack.push(entry)
		this._updateModalView()

		// mask 同步加 .show，吸收触发 showModal 那次 click 链路的残余事件；
		// dialog 此时仍 pointer-events:none，点击不会穿透到按钮。
		entry.mask.classList.add('show')

		const timer = setTimeout(() => {
			this._modalPendingTimers.delete(timer)
			if (this._destroyed)
				return
			// 已被提前 close 出栈就不再 show
			if (!this._modalStack.includes(entry))
				return
			entry.dialog.classList.add('show')
		}, MODAL_GUARD_MS)
		this._modalPendingTimers.add(timer)
	}

	/** 仅栈顶 modal 可见，其余隐藏；任何 push/pop 之后都该调一次。 */
	_updateModalView(): void {
		const topIdx = this._modalStack.length - 1
		for (let i = 0; i < this._modalStack.length; i++) {
			const e = this._modalStack[i]
			if (i === topIdx) {
				e.mask.classList.remove('dimina-modal--occluded')
				e.dialog.classList.remove('dimina-modal--occluded')
			}
			else {
				e.mask.classList.add('dimina-modal--occluded')
				e.dialog.classList.add('dimina-modal--occluded')
			}
		}
	}

	_mountModal(opts: ShowModalOptions): ModalEntry {
		const {
			title = '',
			content = '',
			showCancel = true,
			cancelText = '取消',
			cancelColor = '#000',
			confirmText = '确定',
			confirmColor = '#576b95',
			success,
			complete,
		} = opts
		const { onSuccess, onComplete } = this._createApiCallbacks({ success, complete })

		const mask = document.createElement('div')
		mask.className = 'dimina-dialog-mask'
		mask.addEventListener('touchmove', preventModalTouchMove, { passive: false })

		const dialog = document.createElement('div')
		dialog.className = 'dimina-dialog'

		const depth = this._modalStack.length
		mask.style.zIndex = String(1100 + depth * 20)
		dialog.style.zIndex = String(1110 + depth * 20)

		if (title) {
			const titleEl = document.createElement('h2')
			titleEl.className = 'dimina-dialog__title'
			titleEl.textContent = String(title)
			dialog.appendChild(titleEl)
		}

		// content 为空就不渲染——避免空的 padding 占位
		if (content) {
			const contentEl = document.createElement('p')
			contentEl.className = 'dimina-dialog__content'
			contentEl.textContent = String(content)
			dialog.appendChild(contentEl)
		}

		const btnRow = document.createElement('div')
		btnRow.className = 'dimina-dialog__buttons'

		let closed = false
		const entry: ModalEntry = { mask, dialog, close: null }
		const close = (result?: ModalCloseResult) => {
			if (closed)
				return
			closed = true
			// 按引用弹掉自己（可能不是栈顶）
			const idx = this._modalStack.indexOf(entry)
			if (idx >= 0)
				this._modalStack.splice(idx, 1)

			// 最后一个 modal 播放淡出动画再移除；下面还有 modal 时直接移除，让下一个立刻可见
			if (this._modalStack.length === 0) {
				mask.classList.remove('show')
				dialog.classList.remove('show')
				setTimeout(() => {
					mask.remove()
					dialog.remove()
				}, 200)
			}
			else {
				mask.remove()
				dialog.remove()
			}

			this._updateModalView()
			if (this._modalStack.length === 0) {
				this._unlockModalPageTouch()
			}
			onSuccess?.(result)
			onComplete?.()
		}
		entry.close = close

		if (showCancel) {
			const cancelBtn = document.createElement('button')
			cancelBtn.type = 'button'
			cancelBtn.className = 'dimina-dialog__button'
			cancelBtn.style.color = cancelColor
			cancelBtn.textContent = String(cancelText)
			cancelBtn.addEventListener('click', () => {
				close({ cancel: true, confirm: false, errMsg: 'showModal:ok' })
			})
			btnRow.appendChild(cancelBtn)
		}

		const confirmBtn = document.createElement('button')
		confirmBtn.type = 'button'
		confirmBtn.className = 'dimina-dialog__button'
		confirmBtn.style.color = confirmColor
		confirmBtn.textContent = String(confirmText)
		confirmBtn.addEventListener('click', () => {
			close({ cancel: false, confirm: true, errMsg: 'showModal:ok' })
		})
		btnRow.appendChild(confirmBtn)

		dialog.appendChild(btnRow)

		this.el.appendChild(mask)
		this.el.appendChild(dialog)

		// dialog 的 .show 由 showModal 延迟统一加，触发 transition + 打开 pointer-events
		return entry
	}

	showActionSheet(opts: ShowActionSheetOptions): void {
		const { itemList = [], itemColor = '#000', success, fail, complete } = opts || {}
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })
		if (!Array.isArray(itemList) || itemList.length === 0) {
			onFail?.({ errMsg: 'showActionSheet:fail' })
			onComplete?.()
			return
		}
		// 创建遮罩层
		const mask = document.createElement('div')
		mask.className = 'dimina-action-sheet-mask'
		// 创建 action sheet 容器
		const sheet = document.createElement('div')
		sheet.className = 'dimina-action-sheet'

		// 清理方法
		const cleanup = () => {
			mask.remove()
			sheet.remove()
		}
		// 选项
		itemList.forEach((item, idx) => {
			const btn = document.createElement('div')
			btn.className = 'dimina-action-sheet-item'
			btn.style.color = itemColor
			btn.textContent = item
			btn.onclick = () => {
				cleanup()
				onSuccess?.({ tapIndex: idx, errMsg: 'showActionSheet:ok' })
				onComplete?.()
			}
			sheet.appendChild(btn)
		})
		// 取消按钮
		const cancelBtn = document.createElement('div')
		cancelBtn.className = 'dimina-action-sheet-cancel'
		cancelBtn.textContent = '取消'
		cancelBtn.onclick = () => {
			cleanup()
			onFail?.({ errMsg: 'showActionSheet:fail cancel' })
			onComplete?.()
		}
		sheet.appendChild(cancelBtn)

		mask.onclick = cleanup
		// 挂载到 mini-app 根，避免被 webviewsContainer 的页面层级影响
		this.el.appendChild(mask)
		this.el.appendChild(sheet)
		// 动画效果：等浏览器 paint 后再加 show class，触发 CSS transition
		requestAnimationFrame(() => requestAnimationFrame(() => {
			sheet.classList.add('show')
			mask.classList.add('show')
		}))
	}

	setNavigationBarTitle(opts: SetNavigationBarTitleOptions): void {
		const { title, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })
		try {
			const currentBridge = this.navigator.top!
			const navigationTitle = currentBridge.webview!.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-title')
			if (navigationTitle) {
				navigationTitle.textContent = title || ''
				onSuccess?.({ errMsg: 'setNavigationBarTitle:ok' })
			}
			else {
				onFail?.({ errMsg: `setNavigationBarTitle:fail Navigation title element not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `setNavigationBarTitle:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	setNavigationBarColor(opts: SetNavigationBarColorOptions): void {
		const { frontColor, backgroundColor, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			const currentBridge = this.navigator.top!
			const navigation = currentBridge.webview!.el.querySelector<HTMLElement>('.dimina-native-webview__navigation')
			if (navigation) {
				// 设置前景色（文字颜色）
				if (frontColor) {
					navigation.querySelector<HTMLElement>('.dimina-native-webview__navigation-title')!.style.color = frontColor
				}
				// 设置背景色
				if (backgroundColor) {
					navigation.style.backgroundColor = backgroundColor
				}
				onSuccess?.({ errMsg: 'setNavigationBarColor:ok' })
			}
			else {
				onFail?.({ errMsg: `setNavigationBarColor:fail Navigation element not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `setNavigationBarColor:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	/**
	 * 页面滚动到指定位置
	 */
	pageScrollTo(opts: PageScrollToOptions): void {
		const { scrollTop, duration = 300, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			const currentBridge = this.navigator.top!
			const webviewRoot = currentBridge.webview!.iframe.contentWindow?.document.documentElement
			if (webviewRoot) {
				webviewRoot.scrollTo({
					top: scrollTop,
					behavior: duration > 0 ? 'smooth' : 'auto',
				})

				// 模拟滚动动画时间
				setTimeout(() => {
					onSuccess?.({ errMsg: 'pageScrollTo:ok' })
					onComplete?.()
				}, duration)
			}
			else {
				onFail?.({ errMsg: `pageScrollTo:fail Webview root element not found` })
				onComplete?.()
			}
		}
		catch (error) {
			onFail?.({ errMsg: `pageScrollTo:fail ${getErrorMessage(error)}` })
			onComplete?.()
		}
	}

	/**
	 * 设置剪贴板数据
	 */
	setClipboardData(opts: SetClipboardDataOptions): void {
		const { data, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			navigator.clipboard.writeText(data).then(() => {
				onSuccess?.({ errMsg: 'setClipboardData:ok' })
				onComplete?.()
			}).catch((error) => {
				onFail?.({ errMsg: `setClipboardData:fail ${error.message}` })
				onComplete?.()
			})
		}
		catch (error) {
			onFail?.({ errMsg: `setClipboardData:fail ${getErrorMessage(error)}` })
			onComplete?.()
		}
	}

	/**
	 * 获取剪贴板数据
	 */
	getClipboardData(opts: ApiCallbackOptions): void {
		const { success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			navigator.clipboard.readText().then((data) => {
				onSuccess?.({ data, errMsg: 'getClipboardData:ok' })
				onComplete?.()
			}).catch((error) => {
				onFail?.({ errMsg: `getClipboardData:fail ${error.message}` })
				onComplete?.()
			})
		}
		catch (error) {
			onFail?.({ errMsg: `getClipboardData:fail ${getErrorMessage(error)}` })
			onComplete?.()
		}
	}

	chooseVideo(opts: ApiCallbackOptions & {
		sourceType?: string[]
		camera?: 'front' | 'back'
		maxDuration?: number
	} = {}): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'video/*'
		if (opts.sourceType?.length === 1 && opts.sourceType[0] === 'camera') {
			input.capture = opts.camera === 'front' ? 'user' : 'environment'
		}
		input.style.display = 'none'
		this.el.appendChild(input)
		let pickerSettled = false
		let resultSettled = false
		let focusFallbackTimer: ReturnType<typeof setTimeout> | null = null
		const cleanupPicker = () => {
			globalThis.removeEventListener?.('focus', onWindowFocus)
			if (focusFallbackTimer) clearTimeout(focusFallbackTimer)
			input.remove()
		}
		const settleCancel = () => {
			if (pickerSettled) return
			pickerSettled = true
			cleanupPicker()
			const result = { errMsg: 'chooseVideo:fail cancel' }
			onFail?.(result)
			onComplete?.(result)
		}
		const onWindowFocus = () => {
			focusFallbackTimer = setTimeout(() => {
				if (!pickerSettled && !input.files?.length) settleCancel()
			}, 300)
		}
		const settleResult = (result: Record<string, unknown>, success: boolean) => {
			if (resultSettled) return
			resultSettled = true
			if (success) onSuccess?.(result)
			else onFail?.(result)
			onComplete?.(result)
		}
		input.addEventListener('cancel', settleCancel, { once: true })
		globalThis.addEventListener?.('focus', onWindowFocus)
		input.onchange = () => {
			const file = input.files?.[0]
			if (!file) {
				settleCancel()
				return
			}
			pickerSettled = true
			cleanupPicker()
			const url = URL.createObjectURL(file)
			this._tempObjectUrls.add(url)
			const video = document.createElement('video')
			video.preload = 'metadata'
			video.onloadedmetadata = () => {
				const result = {
					tempFilePath: url,
					duration: Number.isFinite(video.duration) ? video.duration : 0,
					width: video.videoWidth,
					height: video.videoHeight,
					size: file.size,
					errMsg: 'chooseVideo:ok',
				}
				settleResult(result, true)
			}
			video.onerror = () => {
				settleResult({ errMsg: 'chooseVideo:fail unsupported video' }, false)
			}
			video.src = url
		}
		input.click()
	}

	getImageInfo(opts: ApiCallbackOptions & { src?: string }): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!opts.src) {
			const result = { errMsg: 'getImageInfo:fail src is required' }
			onFail?.(result); onComplete?.(result); return
		}
		void this._resolveMediaObjectUrl(opts.src).then((src) => {
			const image = new Image()
			image.onload = () => {
				const pathname = opts.src!.split('?')[0]
				const extension = pathname.includes('.') ? pathname.split('.').pop()!.toLowerCase() : 'unknown'
				const result = {
					width: image.naturalWidth,
					height: image.naturalHeight,
					path: opts.src,
					orientation: 'up',
					type: extension,
					errMsg: 'getImageInfo:ok',
				}
				onSuccess?.(result); onComplete?.(result)
			}
			image.onerror = () => {
				const result = { errMsg: 'getImageInfo:fail unsupported image' }
				onFail?.(result); onComplete?.(result)
			}
			image.src = src
		}).catch((error) => {
			const result = { errMsg: `getImageInfo:fail ${getErrorMessage(error)}` }
			onFail?.(result); onComplete?.(result)
		})
	}

	getVideoInfo(opts: ApiCallbackOptions & { src?: string }): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (!opts.src) {
			const result = { errMsg: 'getVideoInfo:fail src is required' }
			onFail?.(result); onComplete?.(result); return
		}
		void this._resolveMediaObjectUrl(opts.src).then((src) => {
			const video = document.createElement('video')
			video.preload = 'metadata'
			video.onloadedmetadata = async () => {
				let size = 0
				try {
					const response = await fetch(src)
					size = Math.ceil((await response.blob()).size / 1024)
				}
				catch {
					// 元数据可用时，跨域导致拿不到文件大小不应让整个 API 失败。
				}
				const extension = opts.src!.split('?')[0].split('.').pop()?.toLowerCase() ?? 'unknown'
				const result = {
					duration: Number.isFinite(video.duration) ? video.duration : 0,
					width: video.videoWidth,
					height: video.videoHeight,
					orientation: 'up',
					type: extension,
					size,
					bitrate: 0,
					fps: 0,
					errMsg: 'getVideoInfo:ok',
				}
				onSuccess?.(result); onComplete?.(result)
			}
			video.onerror = () => {
				const result = { errMsg: 'getVideoInfo:fail unsupported video' }
				onFail?.(result); onComplete?.(result)
			}
			video.src = src
		}).catch((error) => {
			const result = { errMsg: `getVideoInfo:fail ${getErrorMessage(error)}` }
			onFail?.(result); onComplete?.(result)
		})
	}

	previewMedia(opts: ApiCallbackOptions & {
		sources?: Array<{ url?: string, type?: 'image' | 'video', poster?: string }>
		current?: number
	}): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		const sources = (opts.sources ?? []).filter(source => source.url)
		if (sources.length === 0) {
			const result = { errMsg: 'previewMedia:fail sources is required' }
			onFail?.(result); onComplete?.(result); return
		}
		this._mediaPreviewEl?.remove()
		let current = Math.max(0, Math.min(opts.current ?? 0, sources.length - 1))
		const overlay = document.createElement('div')
		overlay.style.cssText = 'position:absolute;inset:0;z-index:10000;background:#000;display:flex;align-items:center;justify-content:center;'
		const content = document.createElement('div')
		content.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;'
		const indicator = document.createElement('div')
		indicator.style.cssText = 'position:absolute;top:calc(env(safe-area-inset-top) + 16px);left:50%;transform:translateX(-50%);color:white;font:14px sans-serif;z-index:2;'
		const close = document.createElement('button')
		close.type = 'button'
		close.textContent = '×'
		close.style.cssText = 'position:absolute;right:16px;top:calc(env(safe-area-inset-top) + 8px);z-index:3;border:0;background:transparent;color:white;font-size:36px;'
		const render = async () => {
			const renderIndex = current
			content.replaceChildren()
			const source = sources[current]
			try {
				const url = await this._resolveMediaObjectUrl(source.url!)
				if (renderIndex !== current) return
				const media = source.type === 'video' ? document.createElement('video') : document.createElement('img')
				media.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;'
				if (media instanceof HTMLVideoElement) {
					media.controls = true
					media.autoplay = true
					media.poster = source.poster ? await this._resolveMediaObjectUrl(source.poster) : ''
				}
				if (renderIndex !== current) return
				media.src = url
				content.appendChild(media)
				indicator.textContent = `${current + 1}/${sources.length}`
			}
			catch (error) {
				if (renderIndex !== current) return
				content.textContent = `previewMedia:fail ${getErrorMessage(error)}`
				content.style.color = 'white'
			}
		}
		let startX = 0
		content.addEventListener('pointerdown', event => { startX = event.clientX })
		content.addEventListener('pointerup', (event) => {
			const delta = event.clientX - startX
			if (Math.abs(delta) < 40) return
			current = Math.max(0, Math.min(current + (delta < 0 ? 1 : -1), sources.length - 1))
			void render()
		})
		close.onclick = () => { overlay.remove(); if (this._mediaPreviewEl === overlay) this._mediaPreviewEl = null }
		overlay.append(content, indicator, close)
		this.el.appendChild(overlay)
		this._mediaPreviewEl = overlay
		void render()
		const result = { errMsg: 'previewMedia:ok' }
		onSuccess?.(result); onComplete?.(result)
	}

	setKeepScreenOn(opts: ApiCallbackOptions & { keepScreenOn?: boolean }): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		if (typeof opts.keepScreenOn !== 'boolean') {
			const result = { errMsg: 'setKeepScreenOn:fail invalid keepScreenOn' }
			onFail?.(result); onComplete?.(result); return
		}
		const finish = (result: { errMsg: string }, success: boolean) => {
			if (success) onSuccess?.(result); else onFail?.(result)
			onComplete?.(result)
		}
		if (!opts.keepScreenOn) {
			this._keepScreenOnRequested = false
			if (this._wakeLockVisibilityHandler) {
				document.removeEventListener('visibilitychange', this._wakeLockVisibilityHandler)
				this._wakeLockVisibilityHandler = null
			}
			void (this._wakeLockRequest ?? Promise.resolve()).catch(() => {}).then(() => this._releaseWakeLock()).then(() => {
				finish({ errMsg: 'setKeepScreenOn:ok' }, true)
			}).catch(error => finish({ errMsg: `setKeepScreenOn:fail ${getErrorMessage(error)}` }, false))
			return
		}
		this._keepScreenOnRequested = true
		this._installWakeLockVisibilityHandler()
		void this._requestWakeLock().then(() => {
			finish({ errMsg: 'setKeepScreenOn:ok' }, true)
		}).catch((error) => {
			this._keepScreenOnRequested = false
			if (this._wakeLockVisibilityHandler) {
				document.removeEventListener('visibilitychange', this._wakeLockVisibilityHandler)
				this._wakeLockVisibilityHandler = null
			}
			finish({ errMsg: `setKeepScreenOn:fail ${getErrorMessage(error)}` }, false)
		})
	}

	private _installWakeLockVisibilityHandler(): void {
		if (this._wakeLockVisibilityHandler) return
		this._wakeLockVisibilityHandler = () => {
			if (document.visibilityState !== 'visible' || !this._keepScreenOnRequested || this._destroyed) return
			void this._requestWakeLock().catch(() => {})
		}
		document.addEventListener('visibilitychange', this._wakeLockVisibilityHandler)
	}

	private _requestWakeLock(): Promise<void> {
		if (this._wakeLockSentinel && !this._wakeLockSentinel.released) return Promise.resolve()
		if (this._wakeLockRequest) return this._wakeLockRequest
		const wakeLock = (navigator as unknown as NavigatorWithDeviceApis).wakeLock
		if (!wakeLock) return Promise.reject(new Error('screen wake lock is not supported'))

		let tracked: Promise<void>
		tracked = wakeLock.request('screen').then(async (sentinel) => {
			if (!this._keepScreenOnRequested || this._destroyed) {
				await sentinel.release()
				return
			}
			this._wakeLockSentinel = sentinel
			sentinel.addEventListener?.('release', () => {
				if (this._wakeLockSentinel === sentinel) this._wakeLockSentinel = null
			})
		}).finally(() => {
			if (this._wakeLockRequest === tracked) this._wakeLockRequest = null
		})
		this._wakeLockRequest = tracked
		return tracked
	}

	private _releaseWakeLock(): Promise<void> {
		const sentinel = this._wakeLockSentinel
		this._wakeLockSentinel = null
		return sentinel ? sentinel.release() : Promise.resolve()
	}

	async getSetting(opts: ApiCallbackOptions = {}): Promise<void> {
		const { onSuccess, onComplete } = this._createApiCallbacks(opts)
		const authSetting: Record<string, boolean> = {}
		const permissions = (navigator as unknown as { permissions?: Permissions }).permissions
		for (const [scope, name] of [
			['scope.camera', 'camera'],
			['scope.record', 'microphone'],
			['scope.userLocation', 'geolocation'],
		] as const) {
			try {
				authSetting[scope] = (await permissions?.query({ name } as PermissionDescriptor))?.state === 'granted'
			}
			catch { authSetting[scope] = false }
		}
		const result = { authSetting, errMsg: 'getSetting:ok' }
		onSuccess?.(result); onComplete?.(result)
	}

	authorize(opts: ApiCallbackOptions & { scope?: string }): void {
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks(opts)
		const settle = (granted: boolean, reason = 'auth deny') => {
			const result = { errMsg: granted ? 'authorize:ok' : `authorize:fail ${reason}` }
			if (granted) onSuccess?.(result); else onFail?.(result)
			onComplete?.(result)
		}
		if (opts.scope === 'scope.camera' || opts.scope === 'scope.record') {
			if (!navigator.mediaDevices?.getUserMedia) {
				settle(false, 'media permission is not supported')
				return
			}
			navigator.mediaDevices.getUserMedia({
				video: opts.scope === 'scope.camera',
				audio: opts.scope === 'scope.record',
			}).then((stream) => {
				stream.getTracks().forEach(track => track.stop())
				settle(true)
			}).catch(error => settle(false, getErrorMessage(error)))
			return
		}
		if (opts.scope === 'scope.userLocation' && navigator.geolocation) {
			navigator.geolocation.getCurrentPosition(() => settle(true), error => settle(false, error.message))
			return
		}
		settle(false, 'scope is not supported on Web')
	}

	private _resolveMediaUrl(source: string): string {
		return new URL(source, new URL(this.getResourceBaseUrl(), window.location.origin)).toString()
	}

	private async _resolveMediaObjectUrl(source: string): Promise<string> {
		if (source.startsWith(VIRTUAL_USER_PREFIX)) {
			const file = await readWebFile(this.appId, source)
			const url = URL.createObjectURL(file)
			this._tempObjectUrls.add(url)
			return url
		}
		if (source.startsWith(VIRTUAL_FILE_PREFIX)) {
			throw new Error(`temporary virtual file is not available on Web: ${source}`)
		}
		return this._resolveMediaUrl(source)
	}

	/**
	 * Persist a temporary Web resource in this mini program's private file area.
	 * The quoted method name lets invokeApi dispatch the FileSystemManager bridge name directly.
	 */
	'FileSystemManager.saveFile'(opts: SaveFileOptions = {}): void {
		const { tempFilePath = '', filePath, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		saveWebFile({
			appId: this.appId,
			tempFilePath,
			filePath,
			resourceBaseUrl: this.getResourceBaseUrl(),
		}).then((savedFilePath) => {
			const result = { savedFilePath, errMsg: 'FileSystemManager.saveFile:ok' }
			onSuccess?.(result)
			onComplete?.(result)
		}).catch((error) => {
			const result = { errMsg: `FileSystemManager.saveFile:fail ${getErrorMessage(error)}` }
			onFail?.(result)
			onComplete?.(result)
		})
	}

	setStorage(opts: SetStorageOptions): void {
		const { key, data, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			const storageKey = this._storageKey(key)
			this._getStorageAdapter().setItem(storageKey, this._serializeStorageValue(data))
			onSuccess?.({ errMsg: 'setStorage:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `setStorage:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	getStorage(opts: StorageKeyOptions): void {
		const { key, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			const result = this._readStorageValue(this._getStorageAdapter(), key)
			if (result.found) {
				onSuccess?.({ data: result.data, errMsg: 'getStorage:ok' })
			}
			else {
				onFail?.({ errMsg: `getStorage:fail data not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `getStorage:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	removeStorage(opts: StorageKeyOptions): void {
		const { key, success, fail, complete } = opts
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			// A tombstone prevents an ambiguous legacy key from being resurrected
			// without deleting a string that may belong to another legacy appId.
			this._getStorageAdapter().setItem(this._storageKey(key), this._serializeStorageTombstone())
			onSuccess?.({ errMsg: 'removeStorage:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `removeStorage:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	clearStorage(opts: ApiCallbackOptions = {}): void {
		const { success, fail, complete } = opts || {}
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			// Only collision-free v2 keys can be enumerated safely. The marker
			// suppresses fallback to ambiguous legacy-prefix entries after clear.
			const appIdPrefix = this._storageKeyPrefix()
			const keysToRemove: string[] = []
			const storageAdapter = this._getStorageAdapter()

			for (let i = 0; i < storageAdapter.length; i++) {
				const key = storageAdapter.key(i)
				if (key?.startsWith(appIdPrefix)) {
					keysToRemove.push(key)
				}
			}

			keysToRemove.forEach(key => storageAdapter.removeItem(key))
			storageAdapter.setItem(this._legacyStorageDisabledKey(), '1')

			onSuccess?.({ errMsg: 'clearStorage:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `clearStorage:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	getStorageInfo(opts: ApiCallbackOptions = {}): void {
		const { success, fail, complete } = opts || {}
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		try {
			const keys: string[] = []
			let currentSize = 0
			const limitSize = 10 * 1024 * 1024 // 假设限制为10MB
			const appIdPrefix = this._storageKeyPrefix()
			const storageAdapter = this._getStorageAdapter()

			for (let i = 0; i < storageAdapter.length; i++) {
				const fullKey = storageAdapter.key(i)

				// 只处理当前appId的keys；StorageAdapter.key() 允许返回 null（自定义适配器
				// 合法返回值，或枚举过程中存储发生变化），跳过而不是断言非空后直接调用字符串方法
				if (fullKey?.startsWith(appIdPrefix)) {
					const item = storageAdapter.getItem(fullKey)
					if (item === null) continue
					const record = this._decodeStorageRecord(item)
					if (record.kind === 'deleted') continue
					keys.push(fullKey.substring(appIdPrefix.length))
					currentSize += item.length * 2 // 估算 UTF-16 落盘大小
				}
			}

			onSuccess?.({
				keys,
				currentSize, // 当前占用空间，单位为字节
				limitSize, // 存储限制，单位为字节
				errMsg: 'getStorageInfo:ok',
			})
		}
		catch (error) {
			onFail?.({ errMsg: `getStorageInfo:fail ${getErrorMessage(error)}` })
		}
		finally {
			onComplete?.()
		}
	}

	/**
	 * 从 `${module}_${event}` 格式的 key 中还原 module 与 event。
	 * 用已注册模块名做前缀匹配，支持模块名本身含下划线；失败时均为 null。
	 */
	_parseExtEventKey(eventKey: string): { module: string | null, event: string | null } {
		const modules = this.parent?.appManager?.getExtModules() ?? {}
		for (const moduleName of Object.keys(modules)) {
			const prefix = `${moduleName}_`
			if (eventKey.startsWith(prefix)) {
				return { module: moduleName, event: eventKey.slice(prefix.length) }
			}
		}
		return { module: null, event: null }
	}

	/**
	 * 第三方扩展调用的统一入口
	 *
	 * service 侧 extBridge/extOnBridge/extOffBridge 的 invokeAPI 名称规则：
	 *   extBridge   → name = event,              params = { module, data, success, fail, complete }
	 *   extOnBridge → name = `${module}_${event}`, params = { success(callBack), evtId }
	 *   extOffBridge→ name = `${module}_${event}`, params = { success(undefined), evtId }
	 *
	 * 区分方式：
	 *   - extBridge：params 中携带 module 字段
	 *   - extOnBridge vs extOffBridge：success 有值 → on；否则 → off
	 */
	_handleExtCall(name: string, params: ExtCallParams = {}): void {
		if (params.module !== undefined) {
			this._extBridgeCall(name, params)
		}
		else if (params.success) {
			this._extOnBridgeCall(name, params)
		}
		else {
			this._extOffBridgeCall(name)
		}
	}

	/**
	 * 对应 service 侧 extBridge：
	 * invokeAPI(event, { module, data, success, fail, complete, keep })
	 * → container: name=event, params={ module, data, success, fail, complete }
	 */
	_extBridgeCall(event: string, params: ExtCallParams): void {
		const { module, data = {}, success, fail, complete } = params
		const { onSuccess, onFail, onComplete } = this._createApiCallbacks({ success, fail, complete })

		const handler = this.parent?.appManager?.getExtModule(module!)
		if (!handler) {
			const errMsg = `extBridge:fail module "${module}" not registered`
			console.error(`[container] ${errMsg}`)
			onFail?.({ errMsg })
			onComplete?.()
			return
		}

		try {
			handler({
				event,
				data,
				success: (res) => {
					onSuccess?.(res)
					onComplete?.()
				},
				fail: (err) => {
					onFail?.(err)
					onComplete?.()
				},
			})
		}
		catch (error) {
			onFail?.({ errMsg: `extBridge:fail ${getErrorMessage(error)}` })
			onComplete?.()
		}
	}

	/**
	 * 对应 service 侧 extOnBridge：
	 * invokeAPI(`${module}_${event}`, { evtId, keep:true, success:callBack })
	 * → container: name=`${module}_${event}`, params={ success, evtId }
	 */
	_extOnBridgeCall(eventKey: string, params: ExtCallParams): void {
		const { success } = params
		const onCallback = this.createCallbackFunction(success)

		const { module, event } = this._parseExtEventKey(eventKey)
		if (!module) {
			console.warn(`[container] extOnBridge:fail no registered module matched for key "${eventKey}"`)
			return
		}

		const handler = this.parent?.appManager?.getExtModule(module)

		// 若已有相同订阅，先清理旧的
		const prev = this._extSubscriptions.get(eventKey)
		prev?.()

		try {
			const unsubscribe = handler?.({
				event: event!,
				data: { isSustain: true },
				success: res => onCallback?.(res),
				fail: err => console.error(`[container] extOnBridge error (${eventKey}):`, err),
			})

			this._extSubscriptions.set(eventKey, unsubscribe ?? null)
		}
		catch (error) {
			console.error(`[container] extOnBridge:fail ${getErrorMessage(error)}`)
		}
	}

	/**
	 * 对应 service 侧 extOffBridge：
	 * invokeAPI(`${module}_${event}`, { success:undefined })
	 * → container: name=`${module}_${event}`, params={ success:undefined }
	 */
	_extOffBridgeCall(eventKey: string): void {
		const unsubscribe = this._extSubscriptions.get(eventKey)
		if (unsubscribe) {
			unsubscribe()
			this._extSubscriptions.delete(eventKey)
		}
	}
}
