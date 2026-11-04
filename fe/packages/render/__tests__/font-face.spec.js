import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FontFaceLoader } from '../src/core/font-face'
import { resolveFontFaceSource } from '@dimina/common'

const definition = { family: 'Brand', source: 'url("dimina-font://brand")' }

describe('document font registration', () => {
	let target, loader, pending, faces
	beforeEach(() => {
		pending = []
		faces = new Set()
		target = {
			document: { baseURI: 'https://dimina.local/jssdk/1/main/pageFrame.html', fonts: faces },
			FontFace: class {
				constructor(family, source, desc) { Object.assign(this, { family, source, desc }) }
				load() { return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(this), reject, face: this })) }
			},
		}
		loader = new FontFaceLoader(target)
	})
	async function start() { await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)) }
	it('does not activate until loading succeeds, and coalesces duplicates', async () => {
		const loaded = loader.load(definition)
		expect(loader.load(definition)).toBe(loaded)
		await start()
		expect(faces.size).toBe(0)
		expect(pending[0].face.source).toBe('url("https://dimina.local/__dimina_host_fonts/brand")')
		pending[0].resolve()
		await loaded
		expect(faces.size).toBe(1)
	})
	it.each(['dimina:///pageFrame.html', 'http://127.0.0.1/pageFrame.html', 'file:///sdk/pageFrame.html'])(
		'maps host resources onto the render scheme: %s', (base) => {
			expect(resolveFontFaceSource(definition.source, base)).toBe(`url("${new URL('/__dimina_host_fonts/brand', base).href}")`)
		})
	it('keeps remote web font URLs intact', () => {
		expect(resolveFontFaceSource('url("https://cdn.example/font.woff2")', target.document.baseURI)).toBe('url("https://cdn.example/font.woff2")')
	})
	it('cleans owned fonts but preserves external fonts when a WebView is reused', async () => {
		const external = {}
		faces.add(external)
		const loaded = loader.load(definition)
		await start()
		pending[0].resolve()
		await loaded
		loader.reset()
		expect([...faces]).toEqual([external])
	})
	it('does not install an old asynchronous result into a reused document', async () => {
		const loaded = loader.load(definition)
		const rejection = expect(loaded).rejects.toThrow('page unloaded')
		await start()
		loader.reset()
		pending[0].resolve()
		await rejection
		expect(faces.size).toBe(0)
	})
	it('can retry a failed font', async () => {
		const first = loader.load(definition)
		const rejection = expect(first).rejects.toThrow('bad data')
		await start()
		pending.shift().reject(new Error('bad data'))
		await rejection
		const second = loader.load(definition)
		await start()
		pending[0].resolve()
		await second
		expect(faces.size).toBe(1)
	})
	it('serializes replacement loads and can restore a previously used source', async () => {
		const first = loader.load(definition)
		const second = loader.load({ ...definition, source: 'url("dimina-font://other")' })
		await start()
		expect(pending).toHaveLength(1)
		pending.shift().resolve()
		await first
		await start()
		pending.shift().resolve()
		await second
		expect([...faces][0].source).toContain('/other')
		const restored = loader.load(definition)
		await start()
		pending.shift().resolve()
		await restored
		expect(faces.size).toBe(1)
		expect([...faces][0].source).toContain('/brand')
	})
})
