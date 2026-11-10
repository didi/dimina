function chatMessages({ system, prompt, files = {}, messages = [] }, includeSystem = true) {
	const result = includeSystem && system ? [{ role: 'system', content: system }] : []
	if (Object.keys(files).length) result.push({ role: 'user', content: `当前小程序完整源码（JSON），请在此基础上修改并返回完整工程：\n${JSON.stringify(files)}` })
	result.push(...(messages.length ? messages.map(({ role, content }) => ({ role, content })) : [{ role: 'user', content: prompt }]))
	return result
}

/** Developer-owned gateway, Chat Completions or Anthropic Messages. Credentials are never persisted. */
export function createHttpProvider({ url, protocol = 'gateway', headers = {}, model, maxTokens = 8192, fetch: request = globalThis.fetch }) {
	let endpoint
	try { endpoint = new URL(url, globalThis.location?.href) }
	catch { throw new Error('请填写有效的模型接口地址') }
	if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('模型接口必须使用 HTTP 或 HTTPS')
	if (!['gateway', 'chat-completions', 'anthropic-messages'].includes(protocol)) throw new Error('不支持的模型接口协议')
	const anthropic = protocol === 'anthropic-messages'
	if (protocol !== 'gateway') {
		if (typeof model !== 'string' || !model.trim()) throw new Error('请填写模型名称')
		const path = endpoint.pathname.replace(/\/+$/, '')
		endpoint.pathname = anthropic
			? (path.endsWith('/messages') ? path : `${path}${path.endsWith('/v1') ? '' : '/v1'}/messages`)
			: (path.endsWith('/chat/completions') ? path : `${path}/chat/completions`)
	}
	const requestHeaders = { 'Content-Type': 'application/json', ...headers }
	if (anthropic) {
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens 必须为正整数')
		const supplied = new Headers(headers)
		for (const [key, value] of Object.entries({ 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' })) {
			if (!supplied.has(key)) requestHeaders[key] = value
		}
	}
	return {
		async generate({ signal, ...input }) {
			const body = anthropic
				? { model, system: input.system, messages: chatMessages(input, false), max_tokens: maxTokens, stream: false }
				: protocol === 'chat-completions' ? { model, messages: chatMessages(input), stream: false } : { ...input, model }
			let response
			try {
				response = await request(endpoint.href, {
					method: 'POST', signal, credentials: 'omit', redirect: 'error',
					headers: requestHeaders,
					body: JSON.stringify(body),
				})
			} catch (error) {
				if (signal?.aborted || error.name === 'AbortError') throw error
				throw new Error('无法连接模型接口，请检查网络及服务端的跨域（CORS）设置。')
			}
			if (!response.ok) {
				const hint = ({
					400: '请检查所选协议、模型名称和请求参数。',
					401: '请检查访问令牌是否有效。',
					403: '请检查令牌及模型访问权限。',
					404: '请检查接口地址、所选协议和模型名称。',
					429: '请求过于频繁或额度不足，请检查服务额度后重试。',
				})[response.status] || '请稍后重试或检查模型服务状态。'
				throw new Error(`模型接口请求失败（${response.status}）。${hint}`)
			}
			if (protocol !== 'gateway') {
				const result = await response.json()
				if (anthropic && result?.stop_reason === 'max_tokens') throw new Error('模型输出达到长度上限，请简化需求或提高 maxTokens 后重试。')
				const content = anthropic
					? (Array.isArray(result?.content) ? result.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : undefined)
					: result?.choices?.[0]?.message?.content
				if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回文本内容，请检查接口协议和模型配置。')
				return content
			}
			const contentType = response.headers.get('content-type') || ''
			if (contentType.includes('application/json')) return response.json()
			return response.text()
		},
	}
}
