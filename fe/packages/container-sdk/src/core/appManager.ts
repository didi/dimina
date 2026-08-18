import type { Application } from '../pages/application/application.js'
import type { ExtModuleHandler, MiniAppApiHandler, MiniProgramReferrerInfo, OpenAppOptions } from '../types.js'
import { resolveResourceBaseUrl } from '../config.js'
import { MiniApp } from '../pages/miniApp/miniApp.js'
import { queryPath } from '../utils/util.js'

export interface NavigateToMiniProgramRequest {
	appId?: string
	path?: string
	extraData?: unknown
	envVersion?: 'develop' | 'trial' | 'release'
	noRelaunchIfPathUnchanged?: boolean
	shortLink?: string
}

interface InternalOpenAppOptions extends OpenAppOptions {
	allowDefaultPath?: boolean
	referrerInfo?: MiniProgramReferrerInfo
	opener?: MiniApp | null
}

type BeforeDestructiveCommit = () => void | Promise<void>

/**
 * 单个 createContainer() 实例私有的应用管理器：应用登记表与扩展模块表不跨容器共享。
 * 不能做成模块级单例——同一页面可能并存多个容器实例。
 */
export class AppManager {
	/**
	 * 已打开小程序实例的权威登记表，按 appId 键控、无序——谁当前可见由
	 * Application.views（呈现顺序栈）唯一决定，这里的 Map 插入顺序不代表
	 * 任何呈现语义，只用于 getAppById 缓存复用和批量操作（registerApi 广播、
	 * destroy:true 时筛选要销毁的旧实例）。
	 */
	apps: Map<string, MiniApp>
	_extModules: Record<string, ExtModuleHandler>
	_containerApis: Record<string, MiniAppApiHandler>
	_openQueue: Promise<unknown>

	constructor() {
		this.apps = new Map()
		this._extModules = {}
		this._containerApis = {}
		// openApp 串行队列：后一次调用须等前一次完整呈现（含动画）后再开始，
		// 否则会在前一个 app 尚未挂载的中间状态上做销毁，触发竞态。
		this._openQueue = Promise.resolve()
	}

	registerExtModule(moduleName: string, handler: ExtModuleHandler): void {
		this._extModules[moduleName] = handler
	}

	/**
	 * 容器级注册/覆盖 API（对齐 Native 侧 Android MiniApp.registerApi / iOS
	 * pending 注入模式）：立即写入所有已打开实例的注册表，并记入容器级表
	 * 供之后新建的实例在 worker 启动前注入——只有此时注入的名字才能进
	 * registeredApis 被 Object.keys(wx) 枚举。
	 */
	registerApi(name: string, handler: MiniAppApiHandler): void {
		this._containerApis[name] = handler
		for (const app of this.apps.values()) {
			app.registerApi(name, handler)
		}
	}

	getExtModule(moduleName: string): ExtModuleHandler | undefined {
		return this._extModules[moduleName]
	}

	getExtModules(): Record<string, ExtModuleHandler> {
		return this._extModules
	}

	/** 打开/前置小程序，经 _openQueue 串行排队执行。 */
	openApp(opts: OpenAppOptions, dimina: Application): Promise<MiniApp> {
		return this._enqueue(() => this._openApp(opts, dimina))
	}

	_enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._openQueue.then(operation)
		// 失败不卡死队列；result 仍带原始 reject，调用方能感知失败。
		this._openQueue = result.catch(() => {})
		return result
	}

	async _openApp(opts: InternalOpenAppOptions, dimina: Application): Promise<MiniApp> {
		const { appId, path, scene, destroy, restoreStack } = opts
		if (!appId || typeof appId !== 'string') {
			throw new Error('[container] openApp: options.appId is required')
		}
		// 逐 app 覆盖走跟 createContainer({ resourceBaseUrl }) 同一套解析 + allowedOrigins
		// 校验，不传就是 undefined，MiniApp 落回容器默认值。
		const resourceBaseUrl = opts.resourceBaseUrl !== undefined
			? resolveResourceBaseUrl(opts.resourceBaseUrl, dimina.allowedOrigins)
			: undefined
		let pagePath: string
		let query: Record<string, string>
		if (path) {
			({ pagePath, query } = queryPath(path))
		}
		else if (!opts.allowDefaultPath && restoreStack?.length) {
			// path 省略时入口页取 restoreStack[0]；前导斜杠归一规则与 queryPath 一致。
			const entry = restoreStack?.[0]
			const entryPagePath = typeof entry?.pagePath === 'string' ? entry.pagePath.replace(/^\/+/, '') : ''
			if (!entryPagePath)
				throw new Error('[container] openApp: restoreStack[0].pagePath must be a non-empty string')
			pagePath = entryPagePath
			query = entry!.query ?? {}
		}
		else {
			// path 省略时留空到 MiniApp.initApp() 读取目标 app-config.json 的
			// entryPagePath；小游戏借此使用固定 game 入口。
			pagePath = ''
			query = {}
		}
		const info = (await dimina.getAppInfo(appId)) ?? {}
		const { name, logo } = info

		if (destroy) { // 打开新小程序前销毁之前的小程序视图
			// 先拍快照：view.destroy() 会同步经 removeApp() 从 apps 里删掉自己，
			// 边遍历原集合边删会漏掉紧随其后的元素。
			const appsToDestroy = [...this.apps.values()].filter(app => app.appId !== appId)
			for (const app of appsToDestroy) {
				const currentBridge = app.navigator.popPage()
				currentBridge?.destroy()
				await dimina.destroyRootView(app) // view.destroy() 内部会把自己从 apps 里移除
			}
		}

		const cacheApp = this.getAppById(appId)

		if (cacheApp) {
			// 等呈现动画完整跑完再返回，下一个排队中的 openApp() 才开始处理。
			await dimina.presentView(cacheApp, true)
			return cacheApp
		}

		const miniApp = new MiniApp({
			appId,
			scene,
			referrerInfo: opts.referrerInfo,
			opener: opts.opener,
			name,
			logo,
			pagePath,
			query,
			restoreStack, // 完整页面栈，用于刷新后静默恢复
			resourceBaseUrl,
		})

		// 容器级 API 须在 presentView 之前注入：jscore.init 会快照 apiRegistry
		// 生成 worker 的 registeredApis，此后注册的名字不可枚举。
		for (const [name, handler] of Object.entries(this._containerApis)) {
			miniApp.registerApi(name, handler)
		}

		this.apps.set(miniApp.appId, miniApp)
		await dimina.presentView(miniApp, false)
		return miniApp
	}

	_navigateContext(source: MiniApp): Application {
		const dimina = source.parent
		if (!dimina || dimina.views[dimina.views.length - 1] !== source) {
			throw new Error('[container] mini program navigation requires the active mini program')
		}
		return dimina
	}

	_referrerInfo(source: MiniApp, extraData: unknown): MiniProgramReferrerInfo {
		return extraData === undefined
			? { appId: source.appId }
			: { appId: source.appId, extraData }
	}

	_sameQuery(left: Record<string, string>, right: Record<string, string>): boolean {
		const leftKeys = Object.keys(left)
		return leftKeys.length === Object.keys(right).length
			&& leftKeys.every(key => left[key] === right[key])
	}

	_validateExtraData(api: string, extraData: unknown): void {
		if (
			extraData !== undefined
			&& Object.prototype.toString.call(extraData) !== '[object Object]'
		) {
			throw new Error(`[container] ${api}: options.extraData must be an object`)
		}
	}

	/** 打开另一个小程序；默认重建目标运行时，显式 noRelaunch 时才复用同路径实例。 */
	navigateToMiniProgram(opts: NavigateToMiniProgramRequest, source: MiniApp): Promise<MiniApp> {
		return this._enqueue(async () => {
			const dimina = this._navigateContext(source)
			if (opts.shortLink !== undefined && typeof opts.shortLink !== 'string') {
				throw new Error('[container] navigateToMiniProgram: options.shortLink must be a string')
			}
			if (opts.shortLink?.trim()) {
				throw new Error('[container] navigateToMiniProgram: shortLink is not supported by this host')
			}
			const appId = typeof opts.appId === 'string' ? opts.appId.trim() : ''
			if (!appId) {
				throw new Error('[container] navigateToMiniProgram: options.appId is required')
			}
			if (appId === source.appId) {
				throw new Error('[container] navigateToMiniProgram: cannot navigate to the current mini program')
			}
			if (opts.path !== undefined && typeof opts.path !== 'string') {
				throw new Error('[container] navigateToMiniProgram: options.path must be a string')
			}
			if (opts.envVersion !== undefined && opts.envVersion !== 'release') {
				throw new Error(`[container] navigateToMiniProgram: envVersion ${String(opts.envVersion)} is not available in this host`)
			}
			if (
				opts.noRelaunchIfPathUnchanged !== undefined
				&& typeof opts.noRelaunchIfPathUnchanged !== 'boolean'
			) {
				throw new Error('[container] navigateToMiniProgram: options.noRelaunchIfPathUnchanged must be a boolean')
			}
			this._validateExtraData('navigateToMiniProgram', opts.extraData)

			const referrerInfo = this._referrerInfo(source, opts.extraData)
			const cacheApp = this.getAppById(appId)
			if (cacheApp && opts.noRelaunchIfPathUnchanged) {
				const requested = opts.path
					? queryPath(opts.path)
					: { pagePath: cacheApp.getHomePagePath() || cacheApp.pagePath, query: {} }
				if (
					requested.pagePath
					&& requested.pagePath === cacheApp.getCurrentPagePath()
					&& this._sameQuery(requested.query, cacheApp.getCurrentPageQuery())
				) {
					cacheApp.opener = source
					cacheApp.queueAppShowOptions({
						scene: 1037,
						path: cacheApp.getCurrentPagePath(),
						query: cacheApp.getCurrentPageQuery(),
						referrerInfo,
					})
					await dimina.presentView(cacheApp, true)
					return cacheApp
				}
			}

			// 默认语义是重新打开目标。缓存实例若在来源下方，直接摘除并销毁，不能
			// 先把它呈现到前台再销毁，否则会产生一组伪造的 onShow/onHide。
			if (cacheApp) {
				if (dimina.views.includes(cacheApp)) {
					await dimina.dismissView(cacheApp, { destroy: true })
				}
				else {
					await dimina.destroyRootView(cacheApp)
				}
			}

			return this._openApp({
				appId,
				path: opts.path,
				scene: 1037,
				allowDefaultPath: true,
				referrerInfo,
				opener: source,
			}, dimina)
		})
	}

	navigateBackMiniProgram(source: MiniApp, extraData: unknown, beforeCommit: BeforeDestructiveCommit): Promise<void> {
		return this._enqueue(async () => {
			const dimina = this._navigateContext(source)
			this._validateExtraData('navigateBackMiniProgram', extraData)
			const opener = source.opener
			const sourceIndex = dimina.views.indexOf(source)
			const openerIndex = opener ? dimina.views.indexOf(opener) : -1
			if (!opener || openerIndex < 0 || openerIndex >= sourceIndex) {
				throw new Error('[container] navigateBackMiniProgram: current mini program was not opened by another mini program')
			}

			// 按 AppHide/PageHide -> success/complete -> PageUnload 的协议顺序排队，再用
			// 同一个 FIFO barrier 确认旧 Worker 已执行完，最后才交给 dismissView 销毁。
			source.onPresentOut()
			await beforeCommit()
			source.queueDestructionLifecycle()
			await source.jscore.flushCallbacks()
			opener.queueAppShowOptions({
				scene: 1038,
				path: opener.getCurrentPagePath(),
				query: opener.getCurrentPageQuery(),
				referrerInfo: this._referrerInfo(source, extraData),
			})
			await dimina.dismissView(source, { destroy: true })
		})
	}

	exitMiniProgram(source: MiniApp, beforeCommit: BeforeDestructiveCommit): Promise<void> {
		return this._enqueue(async () => {
			const dimina = this._navigateContext(source)
			const opener = source.opener
			const sourceIndex = dimina.views.indexOf(source)
			const openerIndex = opener ? dimina.views.indexOf(opener) : -1
			source.onPresentOut()
			await beforeCommit()
			source.queueDestructionLifecycle()
			await source.jscore.flushCallbacks()
			if (opener && openerIndex >= 0 && openerIndex < sourceIndex) {
				opener.queueAppShowOptions({
					scene: 1038,
					path: opener.getCurrentPagePath(),
					query: opener.getCurrentPageQuery(),
					referrerInfo: this._referrerInfo(source, undefined),
				})
			}
			await dimina.dismissView(source, { destroy: true })
		})
	}

	restartMiniProgram(source: MiniApp, path: string, beforeCommit: BeforeDestructiveCommit): Promise<MiniApp> {
		return this._enqueue(async () => {
			const dimina = this._navigateContext(source)
			if (typeof path !== 'string' || !path.trim()) {
				throw new Error('[container] restartMiniProgram: options.path is required')
			}
			const { pagePath, query } = queryPath(path)
			if (!pagePath) {
				throw new Error('[container] restartMiniProgram: options.path is required')
			}

			const replacement = new MiniApp({
				...source.appInfo,
				pagePath,
				query,
				restoreStack: undefined,
				opener: source.opener,
			})
			for (const [name, handler] of Object.entries(source.apiRegistry)) {
				replacement.registerApi(name, handler)
			}

			this.apps.set(source.appId, replacement)
			try {
				await dimina.replaceView(source, replacement, beforeCommit)
			}
			catch (error) {
				// initApp 失败会先 destroy replacement 并从 Map 移除自己；
				// 无论登记项仍是 replacement 还是已被移除，回滚后的权威实例都应恢复为 source。
				const registered = this.apps.get(source.appId)
				if (!registered || registered === replacement) {
					this.apps.set(source.appId, source)
				}
				try {
					replacement.destroy()
				}
				catch {
					// replace 失败时只保留原始错误；replacement.destroy() 已尽力清理。
				}
				throw error
			}
			return replacement
		})
	}

	getAppById(appId: string): MiniApp | null {
		return this.apps.get(appId) ?? null
	}

	/**
	 * 按对象引用而不是单纯按 appId 移除：只有当前登记的仍是这一个实例
	 * 才删除，防止迟到的 destroy() 误删同 appId 下更新的实例
	 * （MiniApp.destroy() 的触发时机与该实例是否仍是当前登记项无关）。
	 */
	removeApp(miniApp: MiniApp): void {
		if (this.apps.get(miniApp.appId) === miniApp) {
			this.apps.delete(miniApp.appId)
		}
	}

	closeApp(miniApp: MiniApp): void {
		miniApp.parent!.dismissView(miniApp, {
			destroy: false,
		})
	}
}
