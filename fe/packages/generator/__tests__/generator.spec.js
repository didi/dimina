import { describe, expect, it, vi } from 'vitest'
import { createGenerator } from '../src/generation.js'
import { parseProject } from '../src/protocol.js'
import { createHttpProvider } from '../src/provider.js'

const source = () => ({ name: '计数器', files: {
	'app.json': '{"pages":["pages/index"]}', 'app.js': 'App({})',
	'pages/index.js': 'Page({data:{count:0}})', 'pages/index.wxml': '<view>{{count}}</view>',
} })

describe('generation transactions', () => {
	it('repairs using the failed source and diagnostics without mutating the saved project', async () => {
		const saved = { id: 'saved-app', version: 2, ...source(), messages: [] }
		const provider = { generate: vi.fn().mockResolvedValueOnce({ ...source(), files: { ...source().files, 'pages/index.js': 'Page({' } }).mockResolvedValueOnce(source()) }
		const compile = vi.fn().mockRejectedValueOnce(new Error('pages/index.js: Unexpected end')).mockResolvedValue({ 'main/logic.js': 'compiled' })
		const generator = createGenerator({ provider, compile })
		const result = await generator.generate({ prompt: '添加按钮', project: saved })
		expect(result.version).toBe(3)
		expect(result.id).toBe(saved.id)
		expect(provider.generate.mock.calls[1][0].messages.at(-1).content).toContain('Unexpected end')
		expect(provider.generate.mock.calls[1][0].messages.at(-2).content).toContain('Page({')
		expect(saved.version).toBe(2)
		expect(saved.files['pages/index.js']).toBe('Page({data:{count:0}})')
	})
	it('stops repair attempts at the configured limit', async () => {
		const provider = { generate: vi.fn().mockResolvedValue(source()) }
		await expect(createGenerator({ provider, compile: vi.fn().mockRejectedValue(new Error('broken')) }).generate({ prompt: '计数器' })).rejects.toThrow('broken')
		expect(provider.generate).toHaveBeenCalledTimes(2)
	})
	it('cancels a streamed generation before compiling or returning a replacement', async () => {
		const controller = new AbortController()
		const compile = vi.fn()
		const provider = { generate: async function* () { yield '{'; controller.abort(); yield '}' } }
		await expect(createGenerator({ provider, compile }).generate({ prompt: '计数器', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
		expect(compile).not.toHaveBeenCalled()
	})
	it('accepts async text chunks from a developer model adapter', async () => {
		const provider = { generate: async function* () { const text = JSON.stringify(source()); yield text.slice(0, 20); yield text.slice(20) } }
		const result = await createGenerator({ provider, compile: async () => ({}) }).generate({ prompt: '计数器' })
		expect(result.files).toEqual(source().files)
	})
})

describe('source contract', () => {
	it.each(['../escape.js', '/absolute.js', 'pages//index.js', 'node_modules/a.ts', '__proto__/a.js'])( 'rejects unsafe or unsupported paths: %s', path => {
		const value = source(); value.files[path] = ''
		expect(() => parseProject(value)).toThrow('文件路径')
	})
	it('rejects missing declared pages and unsupported subpackages', () => {
		const value = source(); value.files['app.json'] = '{"pages":["missing"]}'
		expect(() => parseProject(value)).toThrow('缺少')
		value.files['app.json'] = '{"pages":["pages/index"],"subPackages":[]}'
		expect(() => parseProject(value)).toThrow('主包')
	})
	it('reads a fenced model response', () => {
		expect(parseProject(`\`\`\`json\n${JSON.stringify(source())}\n\`\`\``)).toEqual(source())
	})
})

describe('developer model gateway', () => {
	it('sends the developer contract, abort signal and explicit authorization without cookies', async () => {
		const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(source()), { headers: { 'Content-Type': 'application/json' } }))
		const controller = new AbortController()
		const provider = createHttpProvider({ url: 'https://model.example/generate', model: 'my-model', headers: { Authorization: 'Bearer test-token' }, fetch: request })
		expect(await provider.generate({ prompt: '计数器', files: {}, signal: controller.signal })).toEqual(source())
		const [url, options] = request.mock.calls[0]
		expect(url).toBe('https://model.example/generate')
		expect(options).toMatchObject({ signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer test-token' } })
		expect(JSON.parse(options.body)).toMatchObject({ prompt: '计数器', model: 'my-model' })
	})
})
