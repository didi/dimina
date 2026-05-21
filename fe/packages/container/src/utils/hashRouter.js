/**
 * 管理容器 URL 路由，记录入口页与当前页以支持刷新后恢复。
 *
 * 当前格式：?appId={appId}&entry={rootPagePath}&page={currentPagePath}
 * 兼容旧格式：#{appId}|{page1Path}|{page2Path}?{query}|...
 */
export class HashRouter {
	static ROUTE_QUERY_KEYS = ['appId', 'entry', 'page']

	/**
	 * 将单个页面（pagePath + query 对象）序列化为栈中的一项
	 */
	static _encodePage(pagePath, query) {
		if (query && Object.keys(query).length > 0) {
			const qs = Object.entries(query)
				.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
				.join('&')
			return `${pagePath}?${qs}`
		}
		return pagePath
	}

	/**
	 * 将栈中的一项反序列化为 { pagePath, query }
	 */
	static _decodePage(item) {
		const qIdx = item.indexOf('?')
		if (qIdx === -1) {
			return { pagePath: item, query: {} }
		}
		const pagePath = item.slice(0, qIdx)
		const query = {}
		const params = new URLSearchParams(item.slice(qIdx + 1))
		params.forEach((value, key) => {
			query[key] = value
		})
		return { pagePath, query }
	}

	/**
	 * URLSearchParams 会将路径中的 / 编码为 %2F，这里保留路径可读性。
	 */
	static _encodeSearchValue(value) {
		return encodeURIComponent(value).replace(/%2F/g, '/')
	}

	static _normalizeSearch(search) {
		if (!search) {
			return ''
		}
		return search.startsWith('?') ? search.slice(1) : search
	}

	static _stringifySearchParams(params) {
		return Array.from(params.entries())
			.map(([key, value]) => `${encodeURIComponent(key)}=${this._encodeSearchValue(value)}`)
			.join('&')
	}

	/**
	 * 构建新的 query 路由，保留非路由 query 参数。
	 */
	static buildRouteSearch(appId, stack, currentSearch = typeof window !== 'undefined' ? window.location.search : '') {
		const params = new URLSearchParams(this._normalizeSearch(currentSearch))
		this.ROUTE_QUERY_KEYS.forEach(key => params.delete(key))

		if (!appId || !stack?.length) {
			return this._stringifySearchParams(params)
		}

		const entryPage = stack[0]
		const currentPage = stack[stack.length - 1]
		params.set('appId', appId)
		params.set('entry', this._encodePage(entryPage.pagePath, entryPage.query || {}))
		params.set('page', this._encodePage(currentPage.pagePath, currentPage.query || {}))

		return this._stringifySearchParams(params)
	}

	static buildRouteURL(appId, stack, baseURL = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '') {
		const search = this.buildRouteSearch(appId, stack)
		return `${baseURL}${search ? `?${search}` : ''}`
	}

	/**
	 * 同步入口页与当前页到 query 路由。
	 * @param {string} appId
	 * @param {Array<{pagePath: string, query: object}>} stack
	 */
	static syncStack(appId, stack) {
		const search = this.buildRouteSearch(appId, stack)
		history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
	}

	static clear() {
		const params = new URLSearchParams(this._normalizeSearch(window.location.search))
		this.ROUTE_QUERY_KEYS.forEach(key => params.delete(key))
		const search = this._stringifySearchParams(params)
		history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
	}

	/**
	 * 解析 query 路由，返回 { appId, stack } 或 null。
	 */
	static parseSearch(search) {
		const params = new URLSearchParams(this._normalizeSearch(search))
		const appId = params.get('appId')
		const entry = params.get('entry')
		const page = params.get('page') || entry

		if (!appId || !entry) {
			return null
		}

		const entryPage = this._decodePage(entry)
		if (!entryPage.pagePath) {
			return null
		}

		const stack = [entryPage]
		if (page && page !== entry) {
			const currentPage = this._decodePage(page)
			if (currentPage.pagePath) {
				stack.push(currentPage)
			}
		}

		return { appId, stack }
	}

	/**
	 * 解析旧 hash，返回 { appId, stack } 或 null
	 * stack 为 Array<{pagePath, query}>，index 0 为根页面
	 */
	static parseHash(hash) {
		if (!hash || hash.length <= 1)
			return null
		const str = hash.slice(1)
		const parts = str.split('|')
		if (parts.length < 2)
			return null
		const appId = parts[0]
		const stack = parts.slice(1).map(item => this._decodePage(item))
		if (!appId || stack.length === 0)
			return null
		return { appId, stack }
	}

	/**
	 * 优先解析 query 路由，并兼容旧 hash 路由。
	 */
	static parse(hash, search = typeof window !== 'undefined' ? window.location.search : '') {
		return this.parseSearch(search) || this.parseHash(hash)
	}
}
