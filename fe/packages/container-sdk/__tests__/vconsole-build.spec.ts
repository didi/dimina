import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build, createLogger, createServer } from 'vite'
import { expect, it, vi } from 'vitest'

async function buildPageFrame(configFile: string) {
	const result: any = await build({
		configFile: resolve(process.cwd(), configFile),
		logLevel: 'silent', mode: 'production',
		define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
		plugins: [{
			name: 'assert-webview83-syntax',
			generateBundle(_options, bundle) {
				const visit = (node: any) => {
					if (!node || typeof node !== 'object') return
					// Chrome 83 cannot parse logical assignments, even in disabled debug code.
					if (node.type === 'AssignmentExpression') {
						expect(['||=', '&&=', '??=']).not.toContain(node.operator)
					}
					for (const child of Object.values(node)) {
						if (Array.isArray(child)) child.forEach(visit)
						else if (child && typeof child === 'object') visit(child)
					}
				}
				for (const chunk of Object.values(bundle)) {
					if (chunk.type === 'chunk') visit(this.parse(chunk.code))
				}
			},
		}, {
			name: 'page-frame-build-fixtures', enforce: 'pre',
			resolveId(id) {
				if (id.startsWith('@dimina/') || /\.(scss|css)$/.test(id)) return `\0fixture:${id}`
			},
			load(id) {
				if (!id.startsWith('\0fixture:')) return
				if (id.endsWith('@dimina/common')) return 'export const modDefine = () => {}; export const modRequire = () => {}'
				if (id.endsWith('@dimina/render')) return 'window.renderSawVConsole = Boolean(window.vConsole)'
				return ''
			},
		}],
		build: { write: false, rollupOptions: { input: resolve(process.cwd(), 'src/pages/pageFrame/pageFrame.ts') }, lib: { entry: resolve(process.cwd(), 'src/pages/pageFrame/pageFrame.ts'), formats: ['es'] } },
	})
	const chunks = (Array.isArray(result) ? result.flatMap(item => item.output) : result.output).filter((item: any) => item.type === 'chunk')
	const entry = chunks.find((item: any) => item.isEntry)
	expect(entry.imports).toEqual([])
	expect(entry.dynamicImports).toEqual([])
	return entry
}

it.each(['../container-sdk/vite.config.mjs', '../container/vite.config.mjs'])('lowers vendor syntax for WebView 83 (%s)', async (configFile) => {
	await buildPageFrame(configFile)
})

it('bundles vConsole in production and initializes it before render', async () => {
	const entry = await buildPageFrame('../container-sdk/vite.config.mjs')
	// A consumer must be able to read the bundle without mistaking vConsole's
	// runtime CSS source-map template for the JavaScript file's own source map.
	const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dimina-page-frame-')))
	const logger = createLogger('silent')
	const warn = vi.spyOn(logger, 'warn')
	const server = await createServer({
		root, configFile: false, customLogger: logger,
		server: { middlewareMode: true, watch: null, ws: false },
		optimizeDeps: { noDiscovery: true },
	})
	try {
		await writeFile(resolve(root, 'pageFrame.js'), entry.code)
		expect(await server.transformRequest('/pageFrame.js')).not.toBeNull()
		expect(warn.mock.calls.filter(([message]) => message.includes('Failed to load source map'))).toEqual([])
	}
	finally {
		await server.close()
		await rm(root, { recursive: true, force: true })
	}
	const originalConsole = { ...console }
	for (const enabled of [false, true]) {
		window.history.replaceState({}, '', enabled ? '/?vconsole=1' : '/')
		// Execute the production bundle in the test DOM, including its initialization order.
		// eslint-disable-next-line no-eval
		window.eval(entry.code)
		expect((window as any).renderSawVConsole).toBe(enabled)
		expect(Boolean((window as any).vConsole)).toBe(enabled)
		if (enabled) {
			window.dispatchEvent(new window.Event('dimina:debug-ready'))
			expect((window as any).vConsole.pluginList['dimina-storage']).toBeDefined()
			await vi.waitFor(() => expect(document.querySelector('#__vconsole')).not.toBeNull())
			;(window as any).vConsole.showPlugin('dimina-storage')
			window.dispatchEvent(new CustomEvent('dimina:debug-storage', { detail: { value: [{ key: 'persisted', data: 334 }] } }))
			await vi.waitFor(() => expect(Array.from((document.querySelector('#__vconsole')!.shadowRoot || document.querySelector('#__vconsole'))!.querySelectorAll('input')).some(input => input.value === 'persisted')).toBe(true))
		}
		delete window.vConsole
	}
	Object.assign(console, originalConsole)
})
