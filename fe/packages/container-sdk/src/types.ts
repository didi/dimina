// 容器运行时的共享契约类型。Application/MiniApp 只按类型引用（import type），
// 避免与它们对本文件的引用形成真实的模块加载环。

import type { Application } from './pages/application/application.js'
import type { MiniApp } from './pages/miniApp/miniApp.js'

/** 状态栏几何矩形，宿主 shell.getStatusBarRect() 的返回值形状。 */
export interface StatusBarRect {
	top: number
	left: number
	width: number
	height: number
	right: number
	bottom: number
}

/**
 * 宿主 shell 适配器：状态栏几何与前景色联动。方法可能依赖宿主自身实例状态，
 * SDK 侧调用必须保留 this（见 config.ts resolveShell）。
 */
export interface ShellAdapter {
	getStatusBarRect?: () => StatusBarRect
	updateStatusBarColor?: (color: string) => void
}

/** resolveShell() 归一化后的形状：两个方法都保证存在（缺省安全实现）。 */
export interface ResolvedShell {
	getStatusBarRect: () => StatusBarRect
	updateStatusBarColor: (color: string) => void
}

/** 小程序元信息，由宿主 getAppInfo(appId) 提供。 */
export interface AppInfoMeta {
	name?: string
	logo?: string
}

export type GetAppInfo = (appId: string) => Promise<AppInfoMeta | undefined | null> | AppInfoMeta | undefined | null

/** 页面路径 + query，恢复栈（restoreStack）与 QueryRouter 共用的最小形状。 */
export interface PageStackEntry {
	pagePath: string
	query?: Record<string, string>
}

/**
 * 页面栈变化时把当前小程序路由信息同步到浏览器地址栏的适配器。
 * 默认实现（QueryRouter）会无条件 history.replaceState 改写地址栏 query，
 * 这会破坏宿主自己的 hash-router 或在多容器场景下互相覆盖路由，
 * 因此改为可替换/可关闭：宿主可传 false 关闭同步，或传自定义适配器接管。
 */
export interface UrlSyncAdapter {
	syncStack: (appId: string, stack: PageStackEntry[]) => void
	clear: () => void
	/**
	 * 可选：把当前小程序状态构造成一个可分享的链接。不实现时"复制链接"功能
	 * 会隐藏（不猜测、不拼错误的 URL）——只有内置 QueryRouter 和明确愿意支持
	 * 分享链接的自定义适配器才提供它。
	 */
	buildShareUrl?: (appId: string, stack: PageStackEntry[]) => string
}

/**
 * wx.setStorage/getStorage/removeStorage/clearStorage/getStorageInfo 落地的存储适配器。
 * 默认实现无条件读写 window.localStorage（key 按 `${appId}_${key}` 命名空间隔离，与
 * `fe/packages/container` 旧实现字节级一致），这在宿主自身也用 localStorage、或同一
 * 宿主页面上多个 createContainer() 实例打开同一 appId（写到完全相同的 key，互相覆盖，
 * 与 urlSync 此前的多容器覆盖问题同构）时没有任何关闭或接管手段，因此改为可替换/可
 * 关闭：宿主可传 false 关闭（存储调用一律以 fail 收场，不再触碰 localStorage），或传
 * 自定义适配器接管（例如路由到宿主自己的存储介质，或按容器实例追加命名空间前缀规避
 * 多容器 key 碰撞）。方法形状对齐 window.localStorage 的最小子集，足以覆盖上述 5 个
 * 方法的现有用法。
 */
export interface StorageAdapter {
	getItem: (key: string) => string | null
	setItem: (key: string, value: string) => void
	removeItem: (key: string) => void
	readonly length: number
	key: (index: number) => string | null
}

export interface OpenAppOptions {
	appId: string
	/**
	 * 入口页路径（可带 query，如 'pages/index/index?a=1'）。省略时取
	 * restoreStack[0]；同时提供时以 path 为准；两者都缺失则 openApp reject。
	 */
	path?: string
	scene?: number
	/** 打开新小程序前是否销毁其它已打开的小程序实例。 */
	destroy?: boolean
	/** 刷新后静默恢复用的完整页面栈，index 0 为入口页。 */
	restoreStack?: PageStackEntry[]
	/**
	 * 逐 app 覆盖 createContainer({ resourceBaseUrl }) 的默认资源基路径，用于单容器内
	 * 同时托管部署在不同位置的多个小程序。同样经真实 URL 解析并受 allowedOrigins 约束。
	 */
	resourceBaseUrl?: string
}

/**
 * 第三方扩展模块处理函数。
 * extBridge 一次性调用：payload 带 success/fail；extOnBridge 持续订阅调用：
 * 返回值若为函数，会在 extOffBridge / MiniApp.destroy() 时被当作 unsubscribe 调用。
 */
export type ExtModuleHandler = (payload: {
	event: string
	data?: unknown
	success?: (result?: unknown) => void
	fail?: (error: { errMsg: string }) => void
}) => (() => void) | void

export interface CreateContainerOptions {
	/** 容器根元素，SDK 把应用视图树挂到这里 */
	mount: HTMLElement
	/** 宿主 shell 适配器：{ getStatusBarRect, updateStatusBarColor } */
	shell?: ShellAdapter
	/** 小程序资源基路径 */
	resourceBaseUrl?: string
	/** 渲染层 iframe URL */
	pageFrameUrl?: string
	/**
	 * resourceBaseUrl/pageFrameUrl 最终解析出的 origin 白名单；不传则不限制来源。
	 * 传了则两者（含走缺省值解析出的 origin）都必须精确命中，否则 createContainer() 同步抛错。
	 */
	allowedOrigins?: readonly string[]
	/** 额外 API 命名空间（如 ['qd']） */
	apiNamespaces?: string[]
	/** 小程序元信息提供者 */
	getAppInfo?: GetAppInfo
	/**
	 * 地址栏路由同步：缺省 true 沿用内置 QueryRouter（history.replaceState 改写 query）；
	 * 传 false 完全关闭同步；传自定义 { syncStack, clear } 适配器接管同步逻辑
	 * （例如接入宿主自身的 hash-router，或多容器场景下只保留一个容器同步地址栏）。
	 */
	urlSync?: boolean | UrlSyncAdapter
	/**
	 * 多容器场景下给这个容器实例一个稳定身份 key：内置 QueryRouter 的地址栏 query key
	 * 会按这个 key 命名空间化（如 appId → appId__{instanceKey}），多个容器各自传不同的
	 * instanceKey 即可都安全使用缺省 urlSync:true，不再互相覆盖。不传时行为与现在完全
	 * 一致（不加命名空间）。对自定义 urlSync 适配器没有约束力——只影响内置 QueryRouter。
	 */
	instanceKey?: string
	/**
	 * wx.setStorage/getStorage/removeStorage/clearStorage/getStorageInfo 落地位置：
	 * 缺省 true 沿用内置 window.localStorage（key 按 `${appId}_${key}` 命名空间隔离）；
	 * 传 false 完全关闭（存储调用一律 fail，不再触碰 localStorage）；传自定义
	 * { getItem, setItem, removeItem, length, key } 适配器接管（例如路由到宿主自己的
	 * 存储介质，或按容器实例追加命名空间前缀，规避多容器打开同一 appId 时的 key 碰撞）。
	 */
	storageSync?: boolean | StorageAdapter
	/**
	 * 小程序启动失败通知（app-config.json 不可达/为空/非法、逻辑线程初始化失败等）。
	 * openApp() 不因启动失败而 reject——启动是呈现之后的异步过程，失败经此回调通知。
	 * 容器销毁打断（abort）不会触发。
	 */
	onAppLaunchError?: OnAppLaunchError
	/**
	 * 启动阶段注册的容器级 API，等价于拿到实例后立刻逐个调用 registerApi，
	 * 但保证严格早于任何 openApp()——只有 worker 启动前注册的 API 名字
	 * 才在逻辑层 Object.keys(wx) 中可枚举。
	 */
	apis?: Record<string, MiniAppApiHandler>
	/**
	 * 启动阶段注册的第三方扩展 bridge 模块，等价于拿到实例后立刻逐个调用 registerExtModule。
	 */
	extModules?: Record<string, ExtModuleHandler>
}

/** 小程序启动失败回调：error 为失败原因，context.appId 为触发失败的小程序。 */
export type OnAppLaunchError = (error: unknown, context: { appId: string }) => void

/** 容器级/实例级 API 处理函数：this 绑定为触发调用的 MiniApp 实例。 */
export type MiniAppApiHandler = (this: MiniApp, params?: unknown) => void

export interface ContainerInstance {
	application: Application
	/** 打开/前置小程序；同 appId 二次打开复用缓存实例 */
	openApp: (opts: OpenAppOptions) => Promise<MiniApp>
	/** 关闭（不销毁）当前/指定小程序；没有已打开的小程序时是空操作，不抛错 */
	closeApp: (miniApp?: MiniApp) => void
	registerExtModule: (name: string, handler: ExtModuleHandler) => void
	/**
	 * 容器级注册/覆盖 API（小程序侧经 wx.xxx / 命名空间调用）。
	 * 对已打开和之后打开的小程序都生效；同名以最后一次写入为准。
	 */
	registerApi: (name: string, handler: MiniAppApiHandler) => void
	/** 可选注入根视图（宿主自定义首页，如应用列表页） */
	setRootView: (view: ContainerView) => void
}

/**
 * 容器内部 postMessage 消息信封：Bridge/JSCore/WebView 之间跨 Worker/iframe
 * 边界传递的统一形状。body 字段随 type 变化，编译期无法收敛，用 unknown 承载。
 */
export interface BridgeMessage {
	type: string
	body: Record<string, unknown>
	target?: 'service' | 'render' | 'container'
}

/**
 * 渲染层（fe/packages/render）在 iframe 全局挂出的通信桥：invoke/publish 为
 * 渲染层往容器方向注册的回调，onMessage 为容器往渲染层方向的入口。
 * 只挂在 iframe contentWindow 上，故不进全局 Window 类型增强，由 WebView 按需断言。
 */
export interface DiminaRenderBridge {
	invoke: ((msg: BridgeMessage) => void) | null
	publish: ((msg: BridgeMessage) => void) | null
	onMessage: (msg: BridgeMessage) => void
}

/** 承载 DiminaRenderBridge 的 iframe contentWindow。 */
export type RenderFrameWindow = Window & { DiminaRenderBridge: DiminaRenderBridge }

/**
 * Bridge 承载的单个页面运行上下文，贯穿 Bridge、JSCore、WebView。
 * query 值统一为字符串（见 utils/util.ts queryPath）。
 */
export interface BridgeOptions {
	appId: string
	pagePath: string
	query?: Record<string, string>
	scene?: number
	root?: string
	pages?: string[]
	configInfo: import('./utils/util.js').MergedPageConfig
	isRoot: boolean
}

/**
 * Application 视图栈元素的最小结构形状：只描述 Application 真正调用到的成员。
 * MiniApp 结构上满足它；宿主根视图实现这些字段/方法即可被 setRootView() 接受。
 */
export interface ContainerView {
	el: HTMLElement
	parent?: unknown
	viewDidLoad?: () => void
	onPresentIn?: () => void
	onPresentOut?: () => void
	restoreColorStyle?: () => void
	destroy?: () => void
}
