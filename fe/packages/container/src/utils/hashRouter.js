/**
 * 管理容器 URL hash，格式：#{appId}/{pagePath}?{query}
 * 用于调试时同步小程序页面路径，并支持刷新后恢复页面状态
 */
export class HashRouter {
	static build(appId, pagePath, query) {
		const queryStr = query && Object.keys(query).length > 0
			? `?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
			: ''
		return `#${appId}/${pagePath}${queryStr}`
	}

	static sync(appId, pagePath, query) {
		history.replaceState(null, '', this.build(appId, pagePath, query))
	}

	static clear() {
		history.replaceState(null, '', window.location.pathname + window.location.search)
	}

	static parse(hash) {
		if (!hash || hash.length <= 1)
			return null
		const str = hash.slice(1)
		const slashIdx = str.indexOf('/')
		if (slashIdx === -1)
			return null
		return {
			appId: str.slice(0, slashIdx),
			path: str.slice(slashIdx + 1), // pagePath?query，交给 queryPath 处理
		}
	}
}
