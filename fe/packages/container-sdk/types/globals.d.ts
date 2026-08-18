// 无类型的 @dimina/* workspace 依赖与 Vite 特殊后缀导入的最小环境声明，
// 只覆盖 container-sdk 实际用到的形状。新的无类型导入应补充到这里，而不是散落 @ts-ignore。

// scss 副作用样式导入（application.scss / miniApp.scss / webview.scss / pageFrame.scss）
declare module '*.scss'

// Vite `?raw` 后缀：把文件内容作为字符串默认导出（miniApp.html?raw / webview.html?raw）
declare module '*.html?raw' {
	const content: string
	export default content
}

// Vite `?url` 后缀：把资源解析为最终 URL 字符串默认导出。
// @dimina/service 目前只以构建产物形式存在（dist/service.js），container-sdk 用这个
// URL 去 new Worker(...)。
declare module '@dimina/service?url' {
	const url: string
	export default url
}

// @dimina/common（fe/packages/common/src/core/amd.js）：极简 AMD 风格模块系统，
// 模块导出形状编译期未知，用 unknown，调用方按需收窄。
declare module '@dimina/common' {
	export function modDefine(id: string, factory: (...args: unknown[]) => unknown): void
	export function modRequire<T = unknown>(
		id: string,
		callback?: (exports: T) => void,
		errorCallback?: (error: { mod: string, errMsg: string }) => void,
	): T
	// eslint-disable-next-line ts/no-namespace
	export namespace modRequire {
		function async<T = unknown>(id: string): Promise<T>
	}
}

// @dimina/components 的样式子路径导出，纯副作用导入
declare module '@dimina/components/style'

// @dimina/render：渲染线程运行时，纯副作用导入（把自身挂到 iframe 全局）
declare module '@dimina/render'

// 本包不直接依赖 vite，拿不到 vite/client 的类型；只声明实际读取的字段
interface ImportMetaEnv {
	readonly BASE_URL: string
	readonly DEV: boolean
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

// pageFrame.ts 把 modDefine/modRequire 挂到全局供渲染层产物消费；
// vconsole.ts 挂出 window.__dimina_enable_vconsole__() 按需启用调试面板。
// 本文件没有顶层 import/export，属全局脚本，Window 直接在此声明合并。
interface Window {
	modDefine: (id: string, factory: (...args: unknown[]) => unknown) => void
	modRequire: (<T = unknown>(
		id: string,
		callback?: (exports: T) => void,
		errorCallback?: (error: { mod: string, errMsg: string }) => void,
	) => T) & {
		async: <T = unknown>(id: string) => Promise<T>
	}
	vConsole?: VConsoleInstance
	__dimina_enable_vconsole__: (options?: { x?: number, y?: number }) => Promise<VConsoleInstance>
}

/** vconsole 实例的最小可用形状：container-sdk 只把它当作一个不透明单例持有/传递。 */
interface VConsoleInstance {
	setSwitchPosition: (x: number, y: number) => void
}
