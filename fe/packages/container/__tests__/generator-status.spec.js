// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpProvider } from '@dimina/generator'
import { mountGenerator } from '../src/generator.js'

const dependencies = vi.hoisted(() => ({ provider: { generate: vi.fn() }, compile: vi.fn(), preview: { open: vi.fn(), destroy: vi.fn() }, previewOptions: undefined, color: vi.fn(), store: { list: vi.fn(), get: vi.fn(), put: vi.fn() } }))
vi.mock('@dimina/generator', async () => {
	const { createGenerator } = await import('../../generator/src/generation.js')
	const { parseProject } = await import('../../generator/src/protocol.js')
	const { createSourceArchive, readSourceProject } = await import('../../generator/src/archive.js')
	return {
		createGenerator: options => createGenerator({ compile: dependencies.compile, ...options }),
		createHttpProvider: vi.fn(),
		createPreview: options => { dependencies.previewOptions = options; return dependencies.preview },
		createProjectStore: () => dependencies.store,
		compileProject: (...args) => dependencies.compile(...args), parseProject, createSourceArchive, readSourceProject,
	}
})

const source = { name: '计数器', files: { 'app.json': '{"pages":["pages/index"]}', 'app.js': 'App({})', 'pages/index.js': 'Page({})', 'pages/index.wxml': '<view>计数器</view>' } }
const saved = { id: 'saved-app', ...source, version: 1, resources: {}, messages: [] }
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const $ = id => document.getElementById(id)
let workspace
beforeEach(async () => {
	vi.resetAllMocks()
	createHttpProvider.mockReturnValue(dependencies.provider)
	dependencies.store.list.mockResolvedValue([])
	dependencies.store.get.mockResolvedValue(saved)
	dependencies.store.put.mockResolvedValue()
	dependencies.compile.mockResolvedValue({})
	dependencies.preview.open.mockImplementation(async (_project, { beforeCommit } = {}) => { await beforeCommit?.() })
	document.body.innerHTML = '<div id="editor"></div><div id="preview"></div>'
	workspace = mountGenerator({ root: $('editor'), previewMount: $('preview'), onStatusBarColorChange: dependencies.color })
	await workspace.show()
	$('endpoint').value = 'https://api.deepseek.com'
	$('model').value = 'deepseek-flash'
	$('prompt').value = '生成计数器'
})
afterEach(() => { workspace.destroy(); document.body.replaceChildren() })
function submit() { $('generate-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }

describe('progress inside the simulator', () => {
	it('uses runtime foreground colors only while the saved app is visible and restores them after a failure overlay', async () => {
		await workspace.show(saved.id)
		dependencies.previewOptions.onStatusBarColorChange('white')
		expect(dependencies.color).toHaveBeenLastCalledWith('white')
		dependencies.provider.generate.mockRejectedValue(new Error('model unavailable'))
		submit()
		expect(dependencies.color).toHaveBeenLastCalledWith('black')
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect($('preview-status').dataset.state).toBe('error')
		expect(dependencies.color).toHaveBeenLastCalledWith('black')
		$('preview-resume').click()
		expect(dependencies.color).toHaveBeenLastCalledWith('white')
		workspace.hide()
		dependencies.color.mockClear()
		dependencies.previewOptions.onStatusBarColorChange('white')
		expect(dependencies.color).not.toHaveBeenCalled()
	})

	it('requires an Anthropic model and sends the API key in its own header', async () => {
		$('protocol').value = 'anthropic-messages'
		$('protocol').dispatchEvent(new Event('change'))
		expect($('endpoint').placeholder).toBe('https://api.anthropic.com')
		expect($('model-optional').hidden).toBe(true)
		expect(document.querySelector('label[for="token"]').textContent).toContain('API Key')
		$('model').value = ''
		submit()
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect($('status').textContent).toContain('模型名称')
		expect(createHttpProvider).not.toHaveBeenCalled()
		$('endpoint').value = 'https://api.anthropic.com/v1'
		$('model').value = 'my-claude-model'
		$('token').value = 'fixture-api-key'
		dependencies.provider.generate.mockResolvedValue(source)
		submit()
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect(createHttpProvider).toHaveBeenLastCalledWith({ url: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages', model: 'my-claude-model', headers: { 'x-api-key': 'fixture-api-key' } })
		expect($('preview-status').hidden).toBe(true)
	})

	it('follows generation, compilation, startup and saving, then reveals the running app', async () => {
		const model = deferred(), compile = deferred(), boot = deferred(), save = deferred()
		dependencies.provider.generate.mockReturnValue(model.promise)
		dependencies.compile.mockReturnValue(compile.promise)
		dependencies.preview.open.mockImplementation(async (_project, { beforeCommit }) => { await boot.promise; await beforeCommit() })
		dependencies.store.put.mockReturnValue(save.promise)
		submit()
		expect($('preview-status')?.hidden).toBe(false)
		expect($('preview-status-title').textContent).toContain('生成源码')
		expect($('preview-runtime').inert).toBe(true)
		model.resolve(source)
		await vi.waitFor(() => expect($('preview-status-title').textContent).toContain('编译'))
		compile.resolve({})
		await vi.waitFor(() => expect($('preview-status-title').textContent).toContain('启动'))
		boot.resolve()
		await vi.waitFor(() => expect($('preview-status-title').textContent).toContain('保存'))
		save.resolve()
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect($('preview-status').hidden).toBe(true)
		expect($('preview-runtime').inert).toBe(false)
		expect($('version').textContent).toBe('版本 1')
	})
	it('shows repair feedback when compilation fails and keeps the old app on final failure', async () => {
		await workspace.show(saved.id)
		dependencies.provider.generate.mockResolvedValue(source)
		dependencies.compile.mockRejectedValue(new Error('页面语法错误'))
		const repair = deferred()
		dependencies.provider.generate.mockReturnValueOnce(Promise.resolve(source)).mockReturnValueOnce(repair.promise)
		submit()
		await vi.waitFor(() => expect($('preview-status-title')?.textContent).toContain('修复'))
		repair.resolve(source)
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect($('preview-status').dataset.state).toBe('error')
		expect($('preview-status-detail').textContent).toContain('页面语法错误')
		expect($('version').textContent).toBe('版本 1')
		expect($('preview-resume').hidden).toBe(false)
		$('preview-resume').click()
		expect($('preview-status').hidden).toBe(true)
		expect($('preview-runtime').inert).toBe(false)
	})
	it('clears loading on cancellation and when leaving during a request', async () => {
		dependencies.provider.generate.mockImplementation(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })))
		submit()
		$('cancel').click()
		await vi.waitFor(() => expect($('generate').disabled).toBe(false))
		expect($('preview-status')?.dataset.state).toBe('stopped')
		expect($('preview-status').textContent).toContain('停止')
		submit()
		workspace.hide()
		await workspace.show()
		expect($('preview-status').hidden).toBe(true)
		expect($('generate').disabled).toBe(false)
	})
})
