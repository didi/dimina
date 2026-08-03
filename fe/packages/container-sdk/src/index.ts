import type { ContainerInstance, CreateContainerOptions } from './types.js'
import { AppManager } from './core/appManager.js'
import { Application } from './pages/application/application.js'
import { QueryRouter } from './utils/queryRouter.js'

// 公开导出：宿主解析/构造小程序路由（刷新恢复、分享链接）需要它，
// 而 dist 分发下深路径 import 不可达。
export { QueryRouter }

export { createDefaultShell } from './defaultShell.js'
export type { DefaultShell, DefaultShellOptions } from './defaultShell.js'

/**
 * 创建一个小程序容器运行时实例。
 * 配置与返回值契约见 {@link CreateContainerOptions} / {@link ContainerInstance}。
 */
export function createContainer(options: CreateContainerOptions | Record<string, never> = {}): ContainerInstance {
	const { mount, shell, resourceBaseUrl, pageFrameUrl, apiNamespaces, urlSync, instanceKey, storageSync, getAppInfo, onAppLaunchError, apis, extModules, allowedOrigins } = options

	if (!mount) {
		throw new Error('[container] createContainer: options.mount is required')
	}

	const appManager = new AppManager()

	// apis/extModules 在函数返回之前注册，保证严格早于任何 openApp()。
	for (const [name, handler] of Object.entries(apis ?? {})) {
		appManager.registerApi(name, handler)
	}
	for (const [name, handler] of Object.entries(extModules ?? {})) {
		appManager.registerExtModule(name, handler)
	}

	const application = new Application({ shell, resourceBaseUrl, pageFrameUrl, apiNamespaces, urlSync, instanceKey, storageSync, getAppInfo, onAppLaunchError, appManager, allowedOrigins })
	mount.appendChild(application.el)

	return {
		application,

		openApp(opts) {
			return appManager.openApp(opts, application)
		},

		closeApp(miniApp) {
			const target = miniApp ?? application.views[application.views.length - 1]
			if (!target) {
				return
			}
			appManager.closeApp(target)
		},

		registerExtModule(name, handler) {
			appManager.registerExtModule(name, handler)
		},

		registerApi(name, handler) {
			appManager.registerApi(name, handler)
		},

		setRootView(view) {
			application.initRootView(view)
		},
	}
}

export type {
	AppInfoMeta,
	BridgeMessage,
	ContainerInstance,
	ContainerView,
	CreateContainerOptions,
	ExtModuleHandler,
	GetAppInfo,
	MiniAppApiHandler,
	OpenAppOptions,
	PageStackEntry,
	ResolvedShell,
	ShellAdapter,
	StatusBarRect,
	StorageAdapter,
	UrlSyncAdapter,
} from './types.js'
