import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPILE_CACHE_VERSION } from '../src/common/compile-cache.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const compileCliPath = path.resolve(testDir, '../src/bin/compile.js')

describe('compile CLI persistent dependency cache', () => {
	let tempDir
	let appPath
	let publicPath

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-cli-cache-'))
		appPath = path.join(tempDir, 'example/cache-app')
		publicPath = path.join(tempDir, 'packages/container/public')
		fs.mkdirSync(path.join(tempDir, 'packages/compiler/src'), { recursive: true })
		fs.mkdirSync(publicPath, { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'packages/compiler/src/stamp.js'), 'compiler stamp\n')
		writeAppFile('app.json', JSON.stringify({ pages: ['pages/index/index'] }))
		writeAppFile('app.js', 'App({})\n')
		writeAppFile('app.wxss', '')
		writeAppFile('project.config.json', JSON.stringify({ appid: 'compile-cache-app' }))
		writeAppFile('pages/index/index.json', '{}')
		writeAppFile('pages/index/index.js', 'Page({ data: { value: 1 } })\n')
		writeAppFile('pages/index/index.wxml', '<view>initial</view>\n')
		writeAppFile('pages/index/index.wxss', '.page { color: red; }\n')
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function writeAppFile(relativePath, content) {
		const filePath = path.join(appPath, relativePath)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, content)
	}

	function runCompile() {
		return spawnSync(process.execPath, [compileCliPath], {
			cwd: tempDir,
			encoding: 'utf8',
			env: {
				...process.env,
				NO_COLOR: '1',
			},
		})
	}

	it('skips unchanged apps and incrementally runs only the changed dependency stage', () => {
		const first = runCompile()
		expect(first.status, first.stderr).toBe(0)
		const cachePath = path.join(publicPath, 'compile-cache.json')
		const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
		expect(cache.version).toBe(COMPILE_CACHE_VERSION)
		expect(JSON.stringify(cache)).not.toContain(tempDir)
		expect(cache.apps['cache-app']).toMatchObject({
			appInfo: {
				appId: 'compile-cache-app',
				path: 'pages/index/index',
			},
		})
		expect(cache.apps['cache-app'].dependencyGraph.fileEdges.length).toBeGreaterThan(0)
		expect(Object.keys(cache.apps['cache-app'].fileFingerprints).length).toBeGreaterThan(0)

		const publicAppList = JSON.parse(fs.readFileSync(path.join(publicPath, 'appList.json'), 'utf8'))
		expect(publicAppList[0]).not.toHaveProperty('dependencyGraph')

		const second = runCompile()
		expect(second.status, second.stderr).toBe(0)
		expect(second.stdout).not.toContain('编译项目')

		const logicPath = path.join(publicPath, 'compile-cache-app/main/logic.js')
		const stylePath = path.join(publicPath, 'compile-cache-app/main/pages_index_index.css')
		const logicBefore = fs.readFileSync(logicPath, 'utf8')
		const styleBefore = fs.readFileSync(stylePath, 'utf8')
		writeAppFile('pages/index/index.wxml', '<view>incremental view</view>\n')

		const third = runCompile()
		expect(third.status, third.stderr).toBe(0)
		expect(third.stdout).toContain('编译视图')
		expect(third.stdout).not.toContain('编译逻辑')
		expect(third.stdout).not.toContain('编译样式')
		expect(fs.readFileSync(logicPath, 'utf8')).toBe(logicBefore)
		expect(fs.readFileSync(stylePath, 'utf8')).toBe(styleBefore)
		expect(fs.readFileSync(
			path.join(publicPath, 'compile-cache-app/main/pages_index_index.js'),
			'utf8',
		)).toContain('incremental view')
	})
})
