import type { Application } from '../pages/application/application.js'
import type { ExtModuleHandler, MiniAppApiHandler, OpenAppOptions } from '../types.js'
import { resolveResourceBaseUrl } from '../config.js'
import { MiniApp } from '../pages/miniApp/miniApp.js'
import { queryPath } from '../utils/util.js'

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
		const result = this._openQueue.then(() => this._openApp(opts, dimina))
		// 失败不卡死队列；result 仍带原始 reject，调用方能感知失败。
		this._openQueue = result.catch(() => {})
		return result
	}

	async _openApp(opts: OpenAppOptions, dimina: Application): Promise<MiniApp> {
		const { appId, path, scene, destroy, restoreStack } = opts
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
		else {
			// path 省略时入口页取 restoreStack[0]；前导斜杠归一规则与 queryPath 一致。
			const entry = restoreStack?.[0]
			const entryPagePath = typeof entry?.pagePath === 'string' ? entry.pagePath.replace(/^\/+/, '') : ''
			if (!entryPagePath) {
				throw new Error('[container] openApp: options.path or a non-empty restoreStack (with restoreStack[0].pagePath) is required')
			}
			pagePath = entryPagePath
			query = entry!.query ?? {}
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
