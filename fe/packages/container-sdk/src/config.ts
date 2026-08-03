import type { GetAppInfo, ResolvedShell, ShellAdapter, StatusBarRect, StorageAdapter, UrlSyncAdapter } from './types.js'
import { QueryRouter } from './utils/queryRouter.js'
// createContainer(options) 的配置归一化，均为纯函数、随每次调用独立解析
// （同一进程可并存多个容器实例），结果写入 Application 实例。

// 不取 SDK 构建时的 import.meta.env.BASE_URL：本包以预构建 dist 发布，
// 那个值与宿主的部署路径无关；非根路径部署的宿主必须显式传 resourceBaseUrl。
const DEFAULT_RESOURCE_BASE_URL = '/'

function withTrailingSlash(url: string): string {
	return url.endsWith('/') ? url : `${url}/`
}

function defaultGetStatusBarRect(): StatusBarRect {
	return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }
}

function noop() {}

/**
 * 归一化 shell 适配器：按字段单独兜底。宿主方法可能依赖自身实例状态，
 * 必须 bind 回原对象，不能拷裸函数引用。
 */
export function resolveShell(shell: ShellAdapter = {}): ResolvedShell {
	return {
		getStatusBarRect: shell.getStatusBarRect ? shell.getStatusBarRect.bind(shell) : defaultGetStatusBarRect,
		updateStatusBarColor: shell.updateStatusBarColor ? shell.updateStatusBarColor.bind(shell) : noop,
	}
}

/**
 * allowedOrigins 未传时不限制来源；传了则要求 origin 精确命中名单，
 * 否则在 createContainer() 挂载任何视图之前抛错。
 */
function assertAllowedOrigin(url: URL, allowedOrigins: readonly string[] | undefined, fieldName: string): void {
	if (!allowedOrigins) return
	if (!allowedOrigins.includes(url.origin)) {
		throw new Error(`[container] createContainer: ${fieldName} resolves to origin "${url.origin}", which is not in allowedOrigins`)
	}
}

/**
 * 归一化为带结尾斜杠的绝对 URL（相对路径按 window.location.origin 解析），
 * 供下游直接拼接；畸形输入在此同步抛错，不往下游传。
 */
export function resolveResourceBaseUrl(resourceBaseUrl: string | undefined, allowedOrigins?: readonly string[]): string {
	const resolved = new URL(resourceBaseUrl || DEFAULT_RESOURCE_BASE_URL, window.location.origin)
	assertAllowedOrigin(resolved, allowedOrigins, 'resourceBaseUrl')
	return withTrailingSlash(resolved.toString())
}

/**
 * 渲染层 iframe 的 URL，缺省基于已归一化的 resourceBaseUrl 解析出 pageFrame.html。
 * 显式传入的跨域 pageFrameUrl 需单独命中 allowedOrigins。
 */
export function resolvePageFrameUrl(pageFrameUrl: string | undefined, resourceBaseUrl: string, allowedOrigins?: readonly string[]): string {
	const resolved = pageFrameUrl
		? new URL(pageFrameUrl, window.location.origin)
		: new URL('pageFrame.html', resourceBaseUrl)
	assertAllowedOrigin(resolved, allowedOrigins, 'pageFrameUrl')
	return resolved.toString()
}

export function resolveApiNamespaces(apiNamespaces: string[] = []): string[] {
	return Array.from(new Set(apiNamespaces))
}

export function resolveGetAppInfo(getAppInfo?: GetAppInfo): GetAppInfo {
	return getAppInfo ?? (async () => ({}))
}

// noopUrlSync 不提供 buildShareUrl——sync 已被宿主完全关闭，"复制链接" 应隐藏
// 而不是猜测一个从未同步到地址栏的链接。
const noopUrlSync: UrlSyncAdapter = { syncStack: noop, clear: noop }

/**
 * urlSync 缺省 true → 内置 QueryRouter（history.replaceState 改写地址栏 query）；
 * false → 完全关闭；自定义适配器原样透传，由宿主自行接管同步逻辑（含是否提供
 * buildShareUrl——不提供时"复制链接"功能在 MiniApp 侧隐藏）。
 * instanceKey 只用于内置 QueryRouter 分支的 query key 命名空间化，对自定义适配器
 * 无约束力（由宿主自行决定是否/如何使用）。
 */
export function resolveUrlSync(urlSync: boolean | UrlSyncAdapter = true, instanceKey?: string): UrlSyncAdapter {
	if (urlSync === false) return noopUrlSync
	if (urlSync === true) {
		return {
			syncStack: (appId, stack) => QueryRouter.syncStack(appId, stack, instanceKey),
			clear: () => QueryRouter.clear(instanceKey),
			buildShareUrl: (appId, stack) => QueryRouter.buildRouteURL(appId, stack, undefined, instanceKey),
		}
	}
	return urlSync
}

const STORAGE_SYNC_DISABLED_MESSAGE = 'storageSync is disabled: the container will not read/write localStorage'

/**
 * storageSync: false 时使用的适配器：每个方法调用即抛错，而不是静默吞掉写入/假装
 * 成功——setStorage/getStorage/removeStorage/clearStorage/getStorageInfo 已有 try/catch
 * 包住存储访问，抛出的错误会原样转成对应的 `xxx:fail` 回调，让调用方（小程序）能感知
 * "存储被关闭"这一事实，而不是收到一个之后读不回来的虚假 success。
 */
const disabledStorageAdapter: StorageAdapter = {
	getItem() { throw new Error(STORAGE_SYNC_DISABLED_MESSAGE) },
	setItem() { throw new Error(STORAGE_SYNC_DISABLED_MESSAGE) },
	removeItem() { throw new Error(STORAGE_SYNC_DISABLED_MESSAGE) },
	key() { throw new Error(STORAGE_SYNC_DISABLED_MESSAGE) },
	get length(): number { throw new Error(STORAGE_SYNC_DISABLED_MESSAGE) },
}

/**
 * 包装内置 window.localStorage：每个方法调用时才访问 window.localStorage 本身，
 * 不在适配器创建阶段访问——访问 window.localStorage 这个 getter 在部分第三方存储
 * 受限的浏览器环境下会同步抛 SecurityError，必须推迟到真正调用某个 storage API
 * 时才触发，让抛错走该 API 自己的 fail 回调，而不是让 createContainer() 本身崩溃。
 */
function wrapNativeStorage(): StorageAdapter {
	return {
		getItem: key => window.localStorage.getItem(key),
		setItem: (key, value) => window.localStorage.setItem(key, value),
		removeItem: key => window.localStorage.removeItem(key),
		key: index => window.localStorage.key(index),
		get length(): number {
			return window.localStorage.length
		},
	}
}

/**
 * storageSync 缺省 true → 包装内置 window.localStorage（向后兼容）；
 * false → 每次调用即抛错的适配器；自定义适配器原样透传，由宿主自行接管存储逻辑。
 */
export function resolveStorageAdapter(storageSync: boolean | StorageAdapter = true): StorageAdapter {
	if (storageSync === false) return disabledStorageAdapter
	if (storageSync === true) return wrapNativeStorage()
	return storageSync
}
