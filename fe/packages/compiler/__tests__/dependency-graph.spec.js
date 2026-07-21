import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DependencyGraph } from '../src/common/dependency-graph.js'
import build from '../src/index.js'
import { getDependencyGraph, storeInfo } from '../src/env.js'

describe('compiler dependency graph', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-graph-'))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function writeProjectFile(filePath, content) {
		const fullPath = path.join(tempDir, filePath)
		fs.mkdirSync(path.dirname(fullPath), { recursive: true })
		fs.writeFileSync(fullPath, content)
	}

	function prepareProject() {
		writeProjectFile('app.json', JSON.stringify({
			pages: ['pages/one/index', 'pages/two/index'],
		}))
		writeProjectFile('app.js', 'App({})\n')
		writeProjectFile('app.wxss', '')
		writeProjectFile('project.config.json', JSON.stringify({ appid: 'dependency-graph-app' }))
		for (const pageName of ['one', 'two']) {
			writeProjectFile(`pages/${pageName}/index.json`, JSON.stringify({
				usingComponents: { shared: '../../components/shared/index' },
			}))
			writeProjectFile(`pages/${pageName}/index.js`, 'Page({})\n')
			writeProjectFile(`pages/${pageName}/index.wxml`, `<view>${pageName}<shared /></view>\n`)
			writeProjectFile(`pages/${pageName}/index.wxss`, '')
		}
		writeProjectFile('components/shared/index.json', JSON.stringify({
			component: true,
			usingComponents: { leaf: '../leaf/index' },
		}))
		writeProjectFile('components/shared/index.js', 'Component({})\n')
		writeProjectFile('components/shared/index.wxml', '<leaf />\n')
		writeProjectFile('components/shared/index.wxss', '')
		writeProjectFile('components/leaf/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/leaf/index.js', 'Component({})\n')
		writeProjectFile('components/leaf/index.wxml', '<view>leaf</view>\n')
		writeProjectFile('components/leaf/index.wxss', '')
	}

	it('keeps typed forward and reverse edges across cycles and snapshots', () => {
		const graph = new DependencyGraph()
		graph.addNode('page', { type: 'page', entry: true })
		graph.addNode('a', { type: 'component' })
		graph.addNode('b', { type: 'component' })
		graph.addDependency('page', 'a', 'component')
		graph.addDependency('a', 'b', 'component')
		graph.addDependency('b', 'a', 'component')
		graph.addFile('b', path.join(tempDir, 'b.wxml'), 'view')

		const restored = new DependencyGraph(graph.toJSON())
		expect(restored.getDirectDependencies('a', 'component')).toEqual(['b'])
		expect(restored.getDirectDependents('a', 'component')).toEqual(expect.arrayContaining(['page', 'b']))
		expect(restored.getAffectedEntries(path.join(tempDir, 'b.wxml'))).toEqual(['page'])
		expect(restored.getFileKinds(path.join(tempDir, 'b.wxml'))).toEqual(['view'])
	})

	it('builds page-to-component edges and resolves all affected entries', () => {
		prepareProject()
		storeInfo(tempDir)
		const graph = getDependencyGraph()

		expect(graph.getDirectDependencies('pages/one/index', 'component'))
			.toContain('/components/shared/index')
		expect(graph.getDirectDependencies('/components/shared/index', 'component'))
			.toContain('/components/leaf/index')
		expect(graph.getAffectedEntries(path.join(tempDir, 'components/leaf/index.wxml')))
			.toEqual(['pages/one/index', 'pages/two/index'])
		expect(graph.getFileKinds(path.join(tempDir, 'components/leaf/index.wxml'))).toEqual(['view'])
	})

	it('preserves unaffected page artifacts during an affected-entry rebuild', async () => {
		prepareProject()
		writeProjectFile('shared/helper.js', 'export const value = 1\n')
		writeProjectFile('shared/fragment.wxml', '<text>fragment</text>\n')
		writeProjectFile('shared/colors.wxss', '.shared { color: red; }\n')
		writeProjectFile('shared/logo.png', 'not-a-real-png')
		writeProjectFile('miniprogram_npm/unused/package.json', JSON.stringify({ name: 'unused', version: '1.0.0' }))
		writeProjectFile('miniprogram_npm/unused/index.js', 'module.exports = {}\n')
		writeProjectFile('pages/one/index.js', 'import { value } from "../../shared/helper.js"\nPage({ data: { value } })\n')
		writeProjectFile('pages/one/index.wxml', '<view>one<include src="../../shared/fragment.wxml" /><image src="../../shared/logo.png" /><shared /></view>\n')
		writeProjectFile('pages/one/index.wxss', '@import "../../shared/colors.wxss";\n')
		const outputDir = path.join(tempDir, 'out')
		const firstResult = await build(outputDir, tempDir, false, { sourcemap: true })
		const discoveredGraph = new DependencyGraph(firstResult.dependencyGraph)
		expect(discoveredGraph.getAffectedEntries(path.join(tempDir, 'shared/helper.js')))
			.toEqual(['pages/one/index'])
		expect(discoveredGraph.getAffectedEntries(path.join(tempDir, 'shared/fragment.wxml')))
			.toEqual(['pages/one/index'])
		expect(discoveredGraph.getAffectedEntries(path.join(tempDir, 'shared/colors.wxss')))
			.toEqual(['pages/one/index'])
		expect(discoveredGraph.getAffectedEntries(path.join(tempDir, 'shared/logo.png')))
			.toEqual(['pages/one/index'])
		expect(discoveredGraph.getFileKinds(path.join(tempDir, 'miniprogram_npm/unused/index.js')))
			.toEqual(['config'])
		const unaffectedPath = path.join(outputDir, 'main/pages_two_index.js')
		const unaffectedBefore = fs.readFileSync(unaffectedPath, 'utf8')

		writeProjectFile('pages/one/index.wxml', '<view>one changed<shared /></view>\n')
		await build(outputDir, tempDir, false, {
			sourcemap: true,
			affectedEntries: ['pages/one/index'],
			seedPath: outputDir,
			dependencyGraph: firstResult.dependencyGraph,
		})

		expect(fs.readFileSync(path.join(outputDir, 'main/pages_one_index.js'), 'utf8')).toContain('one changed')
		expect(fs.readFileSync(unaffectedPath, 'utf8')).toBe(unaffectedBefore)
	})
})
