import { parseProject, SYSTEM_PROMPT } from './protocol.js'

/** provider.generate(request) returns a project, JSON text, or async text chunks. */
export function createGenerator({ provider, compile, onProgress = () => {}, maxRepairs = 1 }) {
	if (typeof provider?.generate !== 'function') throw new TypeError('请提供 model provider.generate(request)')
	if (!Number.isInteger(maxRepairs) || maxRepairs < 0) throw new TypeError('maxRepairs 必须是非负整数')
	return {
		async generate({ prompt, project, signal }) {
			if (!prompt?.trim()) throw new Error('请描述你想创建或修改的小程序')
			const id = project?.id || `generated-${crypto.randomUUID()}`
			const messages = [...(project?.messages || []).slice(-8), { role: 'user', content: prompt }]
			let lastError
			for (let attempt = 0; attempt <= maxRepairs; attempt++) {
				signal?.throwIfAborted()
				onProgress({ stage: attempt ? 'repairing' : 'generating', attempt })
				let output = await provider.generate({ system: SYSTEM_PROMPT, prompt, files: project?.files || {}, messages, signal })
				if (output?.[Symbol.asyncIterator]) {
					let text = ''
					for await (const chunk of output) {
						signal?.throwIfAborted(); text += chunk
						if (text.length > 2 * 1024 * 1024) throw new Error('模型输出超过大小限制')
						onProgress({ stage: 'generating', text })
					}
					output = text
				}
				try {
					const source = parseProject(output)
					onProgress({ stage: 'compiling' })
					const resources = await compile(source.files, { appId: id, name: source.name }, { signal })
					signal?.throwIfAborted()
					return { id, ...source, resources, updatedAt: Date.now(), version: (project?.version || 0) + 1, messages: [...messages, { role: 'assistant', content: `已生成：${source.name}` }] }
				} catch (error) {
					if (signal?.aborted || error.name === 'AbortError') throw error
					lastError = error
					messages.push({ role: 'assistant', content: typeof output === 'string' ? output.slice(0, 1024 * 1024) : String(JSON.stringify(output) ?? output).slice(0, 1024 * 1024) }, { role: 'user', content: `工程校验或本地编译失败：${error.message}。请修复并返回完整工程 JSON。` })
				}
			}
			throw lastError
		},
	}
}
