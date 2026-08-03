import type { PageStackEntry } from '../types.js'

/**
 * 管理容器 URL 路由，记录入口页与当前页以支持刷新后恢复。
 *
 * 当前格式：?appId={appId}&entry={rootPagePath}&page={currentPagePath}
 * 兼容旧格式：#{appId}|{page1Path}|{page2Path}?{query}|...
 */
export class QueryRouter {
	static ROUTE_QUERY_KEYS: string[] = ['appId', 'entry', 'page']

	/**
	 * 多容器场景下按 instanceKey 命名空间化基础 query key，如 'appId' + 'hostA' ->
	 * 'appId__hostA'。不传 instanceKey 时原样返回基础 key，保证省略参数的调用方
	 * 逐字节沿用命名空间化之前的行为。
	 */
	static _namespacedKey(baseKey: string, instanceKey?: string): string {
		return instanceKey ? `${baseKey}__${instanceKey}` : baseKey
	}

	/**
	 * 将单个页面（pagePath + query 对象）序列化为栈中的一项
	 */
	static _encodePage(pagePath: string, query: Record<string, string>): string {
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
	static _decodePage(item: string): PageStackEntry {
		const qIdx = item.indexOf('?')
		if (qIdx === -1) {
			return { pagePath: item, query: {} }
		}
		const pagePath = item.slice(0, qIdx)
		const query: Record<string, string> = {}
		const params = new URLSearchParams(item.slice(qIdx + 1))
		params.forEach((value, key) => {
			query[key] = value
		})
		return { pagePath, query }
	}

	/**
	 * URLSearchParams 会将路径中的 / 编码为 %2F，这里保留路径可读性。
	 */
	static _encodeSearchValue(value: string): string {
		return encodeURIComponent(value).replace(/%2F/g, '/')
	}

	static _normalizeSearch(search?: string | null): string {
		if (!search) {
			return ''
		}
		return search.startsWith('?') ? search.slice(1) : search
	}

	static _stringifySearchParams(params: URLSearchParams): string {
		return Array.from(params.entries())
			.map(([key, value]) => `${encodeURIComponent(key)}=${this._encodeSearchValue(value)}`)
			.join('&')
	}

	/**
	 * 构建新的 query 路由，保留非路由 query 参数。instanceKey 存在时只清理/写入
	 * 该 instanceKey 命名空间下的 key，不触碰其它命名空间（含无命名空间的默认）的 key。
	 */
	static buildRouteSearch(appId: string | null | undefined, stack: PageStackEntry[] | null | undefined, currentSearch: string = typeof window !== 'undefined' ? window.location.search : '', instanceKey?: string): string {
		const params = new URLSearchParams(this._normalizeSearch(currentSearch))
		this.ROUTE_QUERY_KEYS.forEach(key => params.delete(this._namespacedKey(key, instanceKey)))

		if (!appId || !stack?.length) {
			return this._stringifySearchParams(params)
		}

		const entryPage = stack[0]
		const currentPage = stack[stack.length - 1]
		params.set(this._namespacedKey('appId', instanceKey), appId)
		params.set(this._namespacedKey('entry', instanceKey), this._encodePage(entryPage.pagePath, entryPage.query || {}))
		params.set(this._namespacedKey('page', instanceKey), this._encodePage(currentPage.pagePath, currentPage.query || {}))

		return this._stringifySearchParams(params)
	}

	static buildRouteURL(appId: string | null | undefined, stack: PageStackEntry[] | null | undefined, baseURL: string = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '', instanceKey?: string): string {
		const search = this.buildRouteSearch(appId, stack, undefined, instanceKey)
		return `${baseURL}${search ? `?${search}` : ''}`
	}

	/**
	 * 同步入口页与当前页到 query 路由。
	 */
	static syncStack(appId: string, stack: PageStackEntry[], instanceKey?: string): void {
		const search = this.buildRouteSearch(appId, stack, undefined, instanceKey)
		history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
	}

	/**
	 * 清空地址栏路由 key。instanceKey 存在时只删除该 instanceKey 自己命名空间下的
	 * key，绝不触碰其它容器（不同 instanceKey，或无 instanceKey 的默认）的 key——
	 * 这是多容器场景下 clear() 不再互相误伤对方路由的关键。
	 */
	static clear(instanceKey?: string): void {
		const params = new URLSearchParams(this._normalizeSearch(window.location.search))
		this.ROUTE_QUERY_KEYS.forEach(key => params.delete(this._namespacedKey(key, instanceKey)))
		const search = this._stringifySearchParams(params)
		history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
	}

	/**
	 * 解析 query 路由，返回 { appId, stack } 或 null。instanceKey 存在时只读该
	 * instanceKey 命名空间下的 key。
	 */
	static parseSearch(search: string, instanceKey?: string): { appId: string, stack: PageStackEntry[] } | null {
		const params = new URLSearchParams(this._normalizeSearch(search))
		const appId = params.get(this._namespacedKey('appId', instanceKey))
		const entry = params.get(this._namespacedKey('entry', instanceKey))
		const page = params.get(this._namespacedKey('page', instanceKey)) || entry

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
	static parseHash(hash: string | null | undefined): { appId: string, stack: PageStackEntry[] } | null {
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
	 * 优先解析 query 路由，并兼容旧 hash 路由。instanceKey 只影响 query 路由解析；
	 * 旧 hash 格式没有 instanceKey 概念，命中该分支时忽略 instanceKey。
	 */
	static parse(hash: string | null | undefined, search: string = typeof window !== 'undefined' ? window.location.search : '', instanceKey?: string): { appId: string, stack: PageStackEntry[] } | null {
		return this.parseSearch(search, instanceKey) || this.parseHash(hash)
	}
}
