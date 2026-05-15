/**
 * 管理容器 URL hash，记录完整页面栈以支持刷新后恢复。
 *
 * 格式：#{appId}|{page1Path}|{page2Path}?{query}|...
 *   - appId 与各页面路径之间用 `|` 分隔
 *   - 每个页面项格式为 `pagePath` 或 `pagePath?key=val&key2=val2`
 *   - 栈顺序从左到右为从底到顶（index 0 = 根页面，末尾 = 当前页）
 */
export class HashRouter {
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
		item.slice(qIdx + 1).split('&').forEach((pair) => {
			const [k, v] = pair.split('=')
			if (k)
				query[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
		})
		return { pagePath, query }
	}

	/**
	 * 同步完整页面栈到 hash
	 * @param {string} appId
	 * @param {Array<{pagePath: string, query: object}>} stack
	 */
	static syncStack(appId, stack) {
		const pages = stack.map(p => this._encodePage(p.pagePath, p.query)).join('|')
		history.replaceState(null, '', `#${appId}|${pages}`)
	}

	static clear() {
		history.replaceState(null, '', window.location.pathname + window.location.search)
	}

	/**
	 * 解析 hash，返回 { appId, stack } 或 null
	 * stack 为 Array<{pagePath, query}>，index 0 为根页面
	 */
	static parse(hash) {
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
}
