import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { storeInfo } from '../src/env.js'
import { DependencyGraph } from '../src/common/dependency-graph.js'
import { NpmBuilder } from '../src/common/npm-builder.js'
import compileConfig from '../src/core/config-compiler.js'
import build from '../src/index.js'
import { createWatchBuildPlan } from '../src/bin/watch.js'

describe('Wasm and PAG package resources', () => {
	let temporary, originalCwd, output
	const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
	const compressed = brotliCompressSync(wasm)
	function write(name, data) {
		const file = path.join(temporary, name)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, data)
	}
	beforeEach(() => {
		originalCwd = process.cwd()
		temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-wasm-assets-'))
		process.chdir(temporary)
		output = path.join(temporary, 'dist')
		process.env.TARGET_PATH = output
		write('project.config.json', JSON.stringify({ appid: 'wasm-test' }))
		write('app.json', JSON.stringify({ pages: ['pages/index'], subPackages: [{ root: 'feature', pages: ['index'] }] }))
		write('app.js', 'App({})')
		write('pages/index.json', '{}')
		write('feature/index.json', '{}')
	})
	afterEach(() => {
		process.chdir(originalCwd)
		delete process.env.TARGET_PATH
		fs.rmSync(temporary, { recursive: true, force: true })
	})
	it('retains dynamic paths and original bytes in the main package and subpackages', () => {
		write('utils/libpag.wasm', wasm)
		write('utils/libpag.wasm.br', compressed)
		write('assets/animation.pag', 'PAG fixture')
		write('assets/video.mp4', Buffer.from([0, 0, 0, 8, 102, 116, 121, 112]))
		write('feature/utils/module.wasm.br', compressed)
		write('node_modules/unused/ignored.wasm', wasm)
		write('dist/stale.wasm', wasm)
		fs.symlinkSync(path.join(temporary, 'utils'), path.join(temporary, 'linked'))
		storeInfo(temporary)
		const graph = new DependencyGraph()
		compileConfig(graph)
		for (const [name, bytes] of [['main/utils/libpag.wasm', wasm], ['main/utils/libpag.wasm.br', compressed], ['main/assets/animation.pag', Buffer.from('PAG fixture')], ['main/assets/video.mp4', Buffer.from([0, 0, 0, 8, 102, 116, 121, 112])], ['feature/utils/module.wasm.br', compressed]]) {
			expect(fs.readFileSync(path.join(output, name))).toEqual(bytes)
		}
		expect(graph.getFileKinds(path.join(temporary, 'utils/libpag.wasm.br'))).toContain('config')
		for (const name of ['main/node_modules', 'main/dist', 'main/linked']) expect(fs.existsSync(path.join(output, name))).toBe(false)
	})
	it('retains Wasm and PAG files when building mini-program npm packages', async () => {
		const prefix = 'miniprogram_npm/libpag/lib/'
		write(prefix + 'libpag.wasm', wasm)
		write(prefix + 'libpag.wasm.br', compressed)
		write(prefix + 'animation.pag', 'PAG fixture')
		write(prefix + 'unrelated.br', compressed)
		storeInfo(temporary)
		const builder = new NpmBuilder(temporary, output)
		await builder.buildNpmPackages()
		expect(fs.readFileSync(path.join(output, prefix + 'libpag.wasm'))).toEqual(wasm)
		expect(fs.readFileSync(path.join(output, prefix + 'libpag.wasm.br'))).toEqual(compressed)
		expect(fs.readFileSync(path.join(output, prefix + 'animation.pag'), 'utf8')).toBe('PAG fixture')
		expect(fs.existsSync(path.join(output, prefix + 'unrelated.br'))).toBe(false)
	})
	it('does not collect previously published business or npm binaries on repeated default builds', async () => {
		delete process.env.TARGET_PATH
		write('utils/libpag.wasm.br', compressed)
		write('miniprogram_npm/libpag/lib/libpag.wasm', wasm)
		const published = path.join(temporary, 'wasm-test')
		for (let round = 0; round < 3; round++) {
			await build(temporary, temporary, true, { stages: [] })
			expect(fs.readdirSync(published, { recursive: true }).filter(name => /\.wasm(?:\.br)?$/.test(name)).sort()).toEqual([
				'main/utils/libpag.wasm.br',
				'miniprogram_npm/libpag/lib/libpag.wasm',
			])
		}
	})
	it('retains seeded resources without rescanning the seed directory as source', async () => {
		delete process.env.TARGET_PATH
		write('utils/current.wasm', wasm)
		write('history/main/utils/retained.wasm', wasm)
		write('history/miniprogram_npm/retained/lib/module.wasm', wasm)
		const seedPath = path.join(temporary, 'history')
		await build(output, temporary, false, { stages: [], seedPath })
		expect(fs.readdirSync(output, { recursive: true }).filter(name => name.endsWith('.wasm')).sort()).toEqual([
			'main/utils/current.wasm',
			'main/utils/retained.wasm',
			'miniprogram_npm/retained/lib/module.wasm',
		])
	})
	it('rebuilds changed Wasm and PAG resources through the mini-game watch plan', async () => {
		delete process.env.TARGET_PATH
		fs.rmSync(path.join(temporary, 'app.json'))
		write('game.json', '{}')
		write('game.js', '')
		write('utils/module.wasm', wasm)
		write('assets/animation.pag', 'original PAG')
		write('miniprogram_npm/runtime/lib/module.wasm', wasm)
		let result = await build(output, temporary, false, { stages: [] })
		const updatedWasm = Buffer.concat([wasm, Buffer.from([0, 1, 0])])
		for (const [name, bytes] of [['utils/module.wasm', updatedWasm], ['assets/animation.pag', Buffer.from('updated PAG')], ['miniprogram_npm/runtime/lib/module.wasm', updatedWasm]]) {
			const filePath = path.join(temporary, name)
			const plan = createWatchBuildPlan({ event: 'change', filePath, dependencyGraph: new DependencyGraph(result.dependencyGraph), publishedPath: output })
			expect(plan.skip).toBe(false)
			expect(plan.options.affectedEntries).toEqual(['game'])
			write(name, bytes)
			result = await build(output, temporary, false, plan.options)
			expect(fs.readFileSync(path.join(output, name.startsWith('miniprogram_npm/') ? '' : 'main', name))).toEqual(bytes)
		}
	})
})
