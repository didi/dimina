import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	createAppCacheEntry,
	createCachedAppBuildPlan,
	createDependencyFileFingerprints,
	getProjectFileManifest,
} from '../src/common/compile-cache.js'
import { DependencyGraph } from '../src/common/dependency-graph.js'

describe('persistent compiler cache', () => {
	let tempDir
	let publishedPath
	let files
	let graph
	let cacheEntry

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-cache-'))
		publishedPath = path.join(tempDir, 'dist/cache-app')
		fs.mkdirSync(publishedPath, { recursive: true })
		files = {
			config: path.join(tempDir, 'pages/index/index.json'),
			logic: path.join(tempDir, 'pages/index/index.js'),
			view: path.join(tempDir, 'pages/index/index.wxml'),
			style: path.join(tempDir, 'pages/index/index.wxss'),
		}
		for (const [kind, filePath] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true })
			fs.writeFileSync(filePath, `${kind}\n`)
		}
		graph = new DependencyGraph()
		graph.addNode('pages/index/index', { type: 'page', entry: true })
		for (const [kind, filePath] of Object.entries(files)) {
			graph.addFile('pages/index/index', filePath, kind)
		}
		const snapshot = graph.toJSON()
		cacheEntry = {
			workPath: tempDir,
			appInfo: { appId: 'cache-app', name: 'cache app', path: 'pages/index/index' },
			dependencyGraph: snapshot,
			projectFiles: getProjectFileManifest(tempDir),
			fileFingerprints: createDependencyFileFingerprints(snapshot),
		}
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function createPlan() {
		return createCachedAppBuildPlan({
			cacheEntry,
			workPath: tempDir,
			publishedPath,
		})
	}

	it('skips an unchanged app without rebuilding it', () => {
		expect(createPlan()).toMatchObject({ mode: 'skip', reason: 'unchanged' })
	})

	it('unions affected stages for changed dependency files', () => {
		fs.writeFileSync(files.view, 'view changed\n')
		fs.writeFileSync(files.style, 'style changed\n')

		expect(createPlan()).toMatchObject({
			mode: 'incremental',
			options: {
				affectedEntries: ['pages/index/index'],
				stages: ['view', 'style'],
				seedPath: publishedPath,
			},
		})
	})

	it('selects only the logic stage for a JavaScript dependency change', () => {
		fs.writeFileSync(files.logic, 'logic changed\n')

		expect(createPlan()).toMatchObject({
			mode: 'incremental',
			options: {
				affectedEntries: ['pages/index/index'],
				stages: ['logic'],
			},
		})
	})

	it('runs initialization without workers for a cached config asset change', () => {
		const iconPath = path.join(tempDir, 'assets/tab.png')
		fs.mkdirSync(path.dirname(iconPath), { recursive: true })
		fs.writeFileSync(iconPath, 'icon\n')
		graph.addFile('pages/index/index', iconPath, 'config')
		cacheEntry.dependencyGraph = graph.toJSON()
		cacheEntry.projectFiles = getProjectFileManifest(tempDir)
		cacheEntry.fileFingerprints = createDependencyFileFingerprints(cacheEntry.dependencyGraph)

		fs.writeFileSync(iconPath, 'icon changed\n')
		expect(createPlan()).toMatchObject({
			mode: 'incremental',
			options: {
				affectedEntries: ['pages/index/index'],
				stages: [],
			},
		})
	})

	it('falls back to a full build for config and structural changes', () => {
		fs.writeFileSync(files.config, '{"changed":true}\n')
		expect(createPlan()).toMatchObject({ mode: 'full', reason: 'config-changed' })

		cacheEntry.fileFingerprints = createDependencyFileFingerprints(cacheEntry.dependencyGraph)
		fs.rmSync(files.view)
		expect(createPlan()).toMatchObject({ mode: 'full', reason: 'file-structure-changed' })
	})

	it('detects new files outside the previous graph as structural changes', () => {
		fs.writeFileSync(path.join(tempDir, 'new-file.js'), 'export default 1\n')
		expect(createPlan()).toMatchObject({ mode: 'full', reason: 'file-structure-changed' })
	})

	it('keeps the dependency graph out of public app info', () => {
		const entry = createAppCacheEntry({
			appId: 'cache-app',
			name: 'cache app',
			path: 'pages/index/index',
			dependencyGraph: graph.toJSON(),
		}, tempDir)

		expect(entry.appInfo).toEqual({
			appId: 'cache-app',
			name: 'cache app',
			path: 'pages/index/index',
		})
		expect(entry.appInfo).not.toHaveProperty('dependencyGraph')
		expect(entry.dependencyGraph.fileEdges).toHaveLength(4)
		expect(entry.dependencyGraph.pathFormat).toBe('relative')
		expect(JSON.stringify(entry)).not.toContain(tempDir)
	})
})
