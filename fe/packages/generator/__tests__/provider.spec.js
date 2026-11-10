import { describe, expect, it, vi } from 'vitest'
import { createHttpProvider } from '../src/provider.js'
import { createGenerator } from '../src/generation.js'

const project = { name: '计数器', files: {
	'app.json': '{"pages":["pages/index"]}', 'app.js': 'App({})',
	'pages/index.js': 'Page({data:{count:0}})', 'pages/index.wxml': '<view>{{count}}</view>',
} }
const completion = content => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { headers: { 'Content-Type': 'application/json' } })
const anthropicMessage = (content, stopReason = 'end_turn') => new Response(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: stopReason }), { headers: { 'Content-Type': 'application/json' } })

describe('Chat Completions model connection', () => {
	it('connects to DeepSeek from its base URL and translates both sides of the protocol', async () => {
		const request = vi.fn(async url => url === 'https://api.deepseek.com/chat/completions'
			? completion(JSON.stringify(project))
			: new Response('', { status: 404 }))
		const controller = new AbortController()
		const provider = createHttpProvider({ url: 'https://api.deepseek.com', protocol: 'chat-completions', model: 'deepseek-flash', headers: { Authorization: 'Bearer test-token' }, fetch: request })
		const messages = [{ role: 'user', content: '加一个按钮' }]
		const result = await provider.generate({ system: '只返回工程 JSON', prompt: '加一个按钮', files: project.files, messages, signal: controller.signal })
		expect(JSON.parse(result)).toEqual(project)
		const options = request.mock.calls[0][1]
		expect(options).toMatchObject({ method: 'POST', signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer test-token' } })
		const body = JSON.parse(options.body)
		expect(body).toEqual({ model: 'deepseek-flash', stream: false, messages: [
			{ role: 'system', content: '只返回工程 JSON' },
			{ role: 'user', content: expect.stringContaining(JSON.stringify(project.files)) },
			...messages,
		] })
		expect(messages).toEqual([{ role: 'user', content: '加一个按钮' }])
	})
	it.each([
		['https://model.example', 'https://model.example/chat/completions'],
		['https://model.example/v1/', 'https://model.example/v1/chat/completions'],
		['https://model.example/api/v2', 'https://model.example/api/v2/chat/completions'],
		['https://model.example/v1/chat/completions', 'https://model.example/v1/chat/completions'],
		['https://model.example/chat/completions/', 'https://model.example/chat/completions'],
	])('accepts a base URL or complete endpoint: %s', async (url, expected) => {
		const request = vi.fn(async () => completion('{}'))
		await createHttpProvider({ url, protocol: 'chat-completions', model: 'custom-model', fetch: request }).generate({ system: 'JSON', prompt: '创建' })
		expect(request.mock.calls[0][0]).toBe(expected)
		expect(JSON.parse(request.mock.calls[0][1].body).messages).toEqual([{ role: 'system', content: 'JSON' }, { role: 'user', content: '创建' }])
	})
	it('passes failed output and compiler diagnostics back as chat history for repair', async () => {
		const failed = { ...project, files: { ...project.files, 'pages/index.js': 'Page({' } }
		const request = vi.fn().mockResolvedValueOnce(completion(JSON.stringify(failed))).mockResolvedValueOnce(completion(JSON.stringify(project)))
		const provider = createHttpProvider({ url: 'https://model.example/v1', protocol: 'chat-completions', model: 'custom-model', fetch: request })
		const compile = vi.fn().mockRejectedValueOnce(new Error('Unexpected end')).mockResolvedValue({})
		const result = await createGenerator({ provider, compile }).generate({ prompt: '创建计数器' })
		expect(result.files).toEqual(project.files)
		const repair = JSON.parse(request.mock.calls[1][1].body)
		expect(repair.messages.at(-2)).toEqual({ role: 'assistant', content: JSON.stringify(failed) })
		expect(repair.messages.at(-1).content).toContain('Unexpected end')
		expect(repair.messages.filter(message => message.content === '创建计数器')).toHaveLength(1)
	})
	it('requires a model for Chat Completions before sending any request', () => {
		const request = vi.fn()
		expect(() => createHttpProvider({ url: 'https://model.example', protocol: 'chat-completions', fetch: request })).toThrow('模型名称')
		expect(request).not.toHaveBeenCalled()
	})
	it('reports a missing assistant answer instead of treating the response envelope as a project', async () => {
		const provider = createHttpProvider({ url: 'https://model.example', protocol: 'chat-completions', model: 'custom-model', fetch: async () => completion(null) })
		await expect(provider.generate({ prompt: '创建' })).rejects.toThrow('未返回文本内容')
	})
})

describe('Anthropic Messages model connection', () => {
	it('uses top-level system instructions, version headers and text blocks for a complete project', async () => {
		const text = JSON.stringify(project)
		const request = vi.fn(async () => anthropicMessage([{ type: 'thinking', thinking: 'not project JSON' }, { type: 'text', text: text.slice(0, 30) }, { type: 'text', text: text.slice(30) }]))
		const controller = new AbortController()
		const provider = createHttpProvider({ url: 'https://api.anthropic.com', protocol: 'anthropic-messages', model: 'my-claude-model', headers: { 'x-api-key': 'test-key' }, fetch: request })
		const messages = [{ role: 'user', content: '加一个按钮' }]
		expect(JSON.parse(await provider.generate({ system: '只返回工程 JSON', prompt: '加一个按钮', files: project.files, messages, signal: controller.signal }))).toEqual(project)
		const [url, options] = request.mock.calls[0]
		expect(url).toBe('https://api.anthropic.com/v1/messages')
		expect(options).toMatchObject({ signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } })
		expect(new Headers(options.headers).has('authorization')).toBe(false)
		expect(JSON.parse(options.body)).toEqual({ model: 'my-claude-model', system: '只返回工程 JSON', max_tokens: 8192, stream: false, messages: [
			{ role: 'user', content: expect.stringContaining(JSON.stringify(project.files)) }, ...messages,
		] })
		expect(messages).toEqual([{ role: 'user', content: '加一个按钮' }])
	})
	it.each([
		['https://model.example/v1/', 'https://model.example/v1/messages'],
		['https://model.example/proxy', 'https://model.example/proxy/v1/messages'],
		['https://model.example/proxy/v1', 'https://model.example/proxy/v1/messages'],
		['https://model.example/v1/messages/', 'https://model.example/v1/messages'],
		['https://model.example/custom/messages', 'https://model.example/custom/messages'],
	])('accepts base or complete Messages endpoints: %s', async (url, expected) => {
		const request = vi.fn(async () => anthropicMessage([{ type: 'text', text: '{}' }]))
		await createHttpProvider({ url, protocol: 'anthropic-messages', model: 'custom-model', maxTokens: 4096, headers: { 'Anthropic-Version': '2026-10-21' }, fetch: request }).generate({ prompt: '创建' })
		expect(request.mock.calls[0][0]).toBe(expected)
		expect(new Headers(request.mock.calls[0][1].headers).get('anthropic-version')).toBe('2026-10-21')
		expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ model: 'custom-model', max_tokens: 4096, stream: false, messages: [{ role: 'user', content: '创建' }] })
	})
	it('repairs a failed compilation using the previous source and compiler diagnostics', async () => {
		const failed = { ...project, files: { ...project.files, 'pages/index.js': 'Page({' } }
		const request = vi.fn().mockResolvedValueOnce(anthropicMessage([{ type: 'text', text: JSON.stringify(failed) }])).mockResolvedValueOnce(anthropicMessage([{ type: 'text', text: JSON.stringify(project) }]))
		const provider = createHttpProvider({ url: 'https://model.example', protocol: 'anthropic-messages', model: 'custom-model', fetch: request })
		const compile = vi.fn().mockRejectedValueOnce(new Error('Unexpected end')).mockResolvedValue({})
		const result = await createGenerator({ provider, compile }).generate({ prompt: '创建计数器', project: { id: 'saved', ...project, version: 1, messages: [] } })
		expect(result.version).toBe(2)
		const repair = JSON.parse(request.mock.calls[1][1].body)
		expect(repair.messages.some(message => message.role === 'system')).toBe(false)
		expect(repair.messages[0].content).toContain(JSON.stringify(project.files))
		expect(repair.messages.at(-2)).toEqual({ role: 'assistant', content: JSON.stringify(failed) })
		expect(repair.messages.at(-1).content).toContain('Unexpected end')
	})
	it('rejects missing models and invalid output limits before requesting', () => {
		expect(() => createHttpProvider({ url: 'https://model.example', protocol: 'anthropic-messages' })).toThrow('模型名称')
		expect(() => createHttpProvider({ url: 'https://model.example', protocol: 'anthropic-messages', model: 'custom-model', maxTokens: 0 })).toThrow('maxTokens')
	})
	it('reports missing text and truncated outputs without treating other blocks as source', async () => {
		const request = vi.fn().mockResolvedValueOnce(anthropicMessage([{ type: 'thinking', thinking: 'not source' }])).mockResolvedValueOnce(anthropicMessage([{ type: 'text', text: '{' }], 'max_tokens'))
		const provider = createHttpProvider({ url: 'https://model.example', protocol: 'anthropic-messages', model: 'custom-model', fetch: request })
		await expect(provider.generate({ prompt: '创建' })).rejects.toThrow('未返回文本内容')
		await expect(provider.generate({ prompt: '创建' })).rejects.toThrow('长度上限')
	})
})

describe('connection diagnostics', () => {
	it('makes a 404 actionable without exposing query credentials or upstream errors', async () => {
		const provider = createHttpProvider({ url: 'https://model.example/generate?key=private-key', headers: { Authorization: 'Bearer private-token' }, fetch: async () => new Response('private-upstream-error', { status: 404 }) })
		const error = await provider.generate({ prompt: '创建' }).catch(value => value)
		expect(error.message).toContain('404')
		expect(error.message).toContain('接口地址')
		expect(error.message).not.toMatch(/private-key|private-token|private-upstream-error/)
	})
	it.each(['gateway', 'chat-completions', 'anthropic-messages'])('keeps cancellation distinguishable from a network or CORS error: %s', async protocol => {
		const error = new DOMException('Stopped', 'AbortError')
		const provider = createHttpProvider({ url: 'https://model.example/generate', protocol, model: 'custom-model', fetch: async () => { throw error } })
		await expect(provider.generate({ prompt: '创建' })).rejects.toBe(error)
	})
})
