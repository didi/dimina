export function uuid() {
	return Math.random().toString(36).slice(2, 7)
}

export function sleep(time) {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve()
		}, time)
	})
}

export function waitForTransitionEnd(element) {
	return new Promise((resolve) => {
		const handler = () => {
			element.removeEventListener('transitionend', handler)
			resolve()
		}
		element.addEventListener('transitionend', handler)
	})
}

export function queryPath(path) {
	const parts = path.split('?')
	// pagePath 统一去除前导斜杠：app-config.json 的 modules key 与 AMD module id
	// 都是无前导斜杠形态，宿主直启 path 与容器内 "/pages/x/y" 写法都在此单点归一，
	// 否则页面配置查找与 service 模块加载会因写法发散而失败
	const pagePath = parts[0].replace(/^\/+/, '')
	const paramStr = parts[1]

	const result = {
		query: {},
		pagePath,
	}

	if (!paramStr) {
		return result
	}

	const paramList = paramStr.split('&')

	paramList.forEach((param) => {
		const key = param.split('=')[0]
		const value = param.split('=')[1]

		result.query[key] = value
	})

	return result
}

export function closest(node, className) {
	let current = node

	while (current?.classList && !current.classList.contains(className)) {
		current = current.parentNode
	}

	if (current === document) {
		return null
	}

	return current
}

export function readFile(filePath) {
	return new Promise((resolve, _) => {
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

export function mergePageConfig(appConfig, pageConfig) {
	const result = {}
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
