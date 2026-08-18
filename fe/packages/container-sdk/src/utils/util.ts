export function uuid() {
	return Math.random().toString(36).slice(2, 7)
}

export function sleep(time: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve()
		}, time)
	})
}

export function waitForTransitionEnd(element: Element): Promise<void> {
	return new Promise((resolve) => {
		const handler = () => {
			element.removeEventListener('transitionend', handler)
			resolve()
		}
		element.addEventListener('transitionend', handler)
	})
}

export interface QueryPathResult {
	pagePath: string
	query: Record<string, string>
}

export function queryPath(path: string): QueryPathResult {
	const queryIndex = path.indexOf('?')
	const rawPagePath = queryIndex === -1 ? path : path.slice(0, queryIndex)
	// pagePath 统一去除前导斜杠：app-config.json 的 modules key 与 AMD module id
	// 都是无前导斜杠形态，宿主直启 path 与容器内 "/pages/x/y" 写法都在此单点归一，
	// 否则页面配置查找与 service 模块加载会因写法发散而失败
	const pagePath = rawPagePath.replace(/^\/+/, '')
	const paramStr = queryIndex === -1 ? '' : path.slice(queryIndex + 1)

	const result: QueryPathResult = {
		query: {},
		pagePath,
	}

	if (!paramStr) {
		return result
	}

	// URLSearchParams 保留值中的 `=`，把无值键归一为空字符串，并与
	// QueryRouter 使用同一套百分号/`+` 解码规则。重复 key 按出现顺序覆盖，
	// 与旧实现的最后一项生效语义一致。
	new URLSearchParams(paramStr).forEach((value, key) => {
		result.query[key] = value
	})

	return result
}

export function closest(node: Node | null, className: string): Element | null {
	let current = node

	while (current && (current as Element).classList && !(current as Element).classList.contains(className)) {
		current = current.parentNode
	}

	if (current === document) {
		return null
	}

	return current as Element | null
}

export function readFile(filePath: string): Promise<string | null> {
	return new Promise((resolve) => {
		fetch(`${filePath}`)
			.then(response => response.text())
			.then((res) => {
				resolve(res)
			})
			.catch(() => {
				resolve(null)
			})
	})
}

/** 页面配置合并结果：小程序页面私有配置覆盖 app.window 全局配置后的最终形态。 */
export interface MergedPageConfig {
	navigationBarTitleText: string
	navigationBarBackgroundColor: string
	navigationBarTextStyle: string
	backgroundColor: string
	navigationStyle: string
	homeButton: boolean
	usingComponents: Record<string, unknown>
}

export interface AppWindowConfig {
	navigationBarTitleText?: string
	navigationBarBackgroundColor?: string
	navigationBarTextStyle?: string
	backgroundColor?: string
	navigationStyle?: string
	homeButton?: boolean
}

export interface PageConfig extends AppWindowConfig {
	usingComponents?: Record<string, unknown>
	root?: string
}

export function mergePageConfig(appConfig: { window?: AppWindowConfig }, pageConfig?: PageConfig | null): MergedPageConfig {
	const result = {} as MergedPageConfig
	const appWindowConfig = appConfig.window || {}
	const pagePrivateConfig = pageConfig || {}

	result.navigationBarTitleText = pagePrivateConfig.navigationBarTitleText || appWindowConfig.navigationBarTitleText || ''
	result.navigationBarBackgroundColor = pagePrivateConfig.navigationBarBackgroundColor || appWindowConfig.navigationBarBackgroundColor || '#000'
	result.navigationBarTextStyle = pagePrivateConfig.navigationBarTextStyle || appWindowConfig.navigationBarTextStyle || 'white'
	result.backgroundColor = pagePrivateConfig.backgroundColor || appWindowConfig.backgroundColor || '#fff'
	result.navigationStyle = pagePrivateConfig.navigationStyle || appWindowConfig.navigationStyle || 'default'
	result.homeButton = pagePrivateConfig.homeButton ?? appWindowConfig.homeButton ?? false
	result.usingComponents = pagePrivateConfig.usingComponents || {}

	return result
}
