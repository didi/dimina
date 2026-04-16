import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceMapConsumer } from 'source-map-js'
import build from '../src/index.js'

const tempDirs = []

function makeTempDir(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	tempDirs.push(dir)
	return dir
}

function writeJson(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function writeSinglePageProject(projectDir, appId, scriptExt, scriptCode) {
	writeJson(path.join(projectDir, 'project.config.json'), {
		appid: appId,
	})
	writeJson(path.join(projectDir, 'app.json'), {
		pages: ['pages/index/index'],
	})

	const pageDir = path.join(projectDir, 'pages/index')
	fs.mkdirSync(pageDir, { recursive: true })
	writeJson(path.join(pageDir, 'index.json'), { usingComponents: {} })
	fs.writeFileSync(path.join(pageDir, `index.${scriptExt}`), scriptCode)
}

function writePageFile(projectDir, relativePath, content) {
	const filePath = path.join(projectDir, relativePath)
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, content)
}

function findLine(code, needle) {
	const line = code.split('\n').findIndex((item) => item.includes(needle))
	return line === -1 ? -1 : line + 1
}

function findColumn(code, line, needle) {
	const lineText = code.split('\n')[line - 1] || ''
	return Math.max(0, lineText.indexOf(needle))
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	}
})

describe('logic sourcemap', () => {
	it('应该把 JS 页面中的断点行映射回原始源码行', async () => {
		const projectDir = makeTempDir('js-sourcemap-project-')
		const outputDir = makeTempDir('js-sourcemap-output-')

		writeSinglePageProject(projectDir, 'js-sourcemap-app', 'js', `function createBoom(scene) {
  throw new Error(\`boom:\${scene}\`)
}

Page({
  onLoad() {
    console.log('[js-map] loaded')
  },

  runSync() {
    console.log('[js-map] sync')
  },

  runError() {
    createBoom('runError')
  },
})
`)

		const buildResult = await build(outputDir, projectDir, true, { sourcemap: true })
		expect(buildResult?.appId).toBe('js-sourcemap-app')

		const logicPath = path.join(outputDir, 'js-sourcemap-app', 'main', 'logic.js')
		const sourcemapPath = path.join(outputDir, 'js-sourcemap-app', 'main', 'logic.js.map')
		expect(fs.existsSync(logicPath)).toBe(true)
		expect(fs.existsSync(sourcemapPath)).toBe(true)

		const logicCode = fs.readFileSync(logicPath, 'utf8')
		const sourcemap = JSON.parse(fs.readFileSync(sourcemapPath, 'utf8'))

		expect(logicCode).toContain('//# sourceMappingURL=logic.js.map')
		expect(sourcemap.sources).toContain('/pages/index/index.js')
		expect(sourcemap.sourcesContent?.[sourcemap.sources.indexOf('/pages/index/index.js')]).toContain('[js-map] loaded')

		const checks = [
			{ needle: '[js-map] loaded', expectedLine: 7 },
			{ needle: '[js-map] sync', expectedLine: 11 },
			{ needle: 'throw new Error(`boom:${scene}`);', expectedLine: 2 },
		]

		const consumer = await new SourceMapConsumer(sourcemap)
		try {
			for (const check of checks) {
				const generatedLine = findLine(logicCode, check.needle)
				expect(generatedLine).toBeGreaterThan(0)
				const generatedColumn = findColumn(logicCode, generatedLine, check.needle)

				const original = consumer.originalPositionFor({ line: generatedLine, column: generatedColumn })
				expect(original.source).toBe('/pages/index/index.js')
				expect(original.line).toBe(check.expectedLine)
			}
		} finally {
			consumer.destroy?.()
		}
	})

	it('应该把 TS 页面中的断点行映射回原始源码行', async () => {
		const projectDir = makeTempDir('ts-sourcemap-project-')
		const outputDir = makeTempDir('ts-sourcemap-output-')

		writeSinglePageProject(projectDir, 'ts-sourcemap-app', 'ts', `type PageData = {
  count: number
}

function computeCount(input: number): number {
  return input + 1
}

function createBoom(scene: string): never {
  throw new Error(\`boom:\${scene}\`)
}

Page<PageData>({
  data: {
    count: 0,
  },

  onLoad() {
    console.log('[ts-map] loaded')
  },

  runSync() {
    const next = computeCount(this.data.count)
    console.log('[ts-map] sync', next)
    this.setData({ count: next })
  },

  runError() {
    createBoom('runError')
  },
})
`)

		const buildResult = await build(outputDir, projectDir, true, { sourcemap: true })
		expect(buildResult?.appId).toBe('ts-sourcemap-app')

		const logicPath = path.join(outputDir, 'ts-sourcemap-app', 'main', 'logic.js')
		const sourcemapPath = path.join(outputDir, 'ts-sourcemap-app', 'main', 'logic.js.map')
		expect(fs.existsSync(logicPath)).toBe(true)
		expect(fs.existsSync(sourcemapPath)).toBe(true)

		const logicCode = fs.readFileSync(logicPath, 'utf8')
		const sourcemap = JSON.parse(fs.readFileSync(sourcemapPath, 'utf8'))

		expect(logicCode).toContain('//# sourceMappingURL=logic.js.map')
		expect(sourcemap.sources).toContain('/pages/index/index.ts')
		expect(sourcemap.sourcesContent?.[sourcemap.sources.indexOf('/pages/index/index.ts')]).toContain('[ts-map] loaded')

		const checks = [
			{ needle: '[ts-map] loaded', expectedLine: 19 },
			{ needle: '[ts-map] sync', expectedLine: 24 },
			{ needle: 'throw new Error(`boom:${scene}`);', expectedLine: 10 },
		]

		const consumer = await new SourceMapConsumer(sourcemap)
		try {
			for (const check of checks) {
				const generatedLine = findLine(logicCode, check.needle)
				expect(generatedLine).toBeGreaterThan(0)
				const generatedColumn = findColumn(logicCode, generatedLine, check.needle)

				const original = consumer.originalPositionFor({ line: generatedLine, column: generatedColumn })
				expect(original.source).toBe('/pages/index/index.ts')
				expect(original.line).toBe(check.expectedLine)
			}
		} finally {
			consumer.destroy?.()
		}
	})

	it('应该在 sourcemap 模式下忽略 TS type-only 依赖', async () => {
		const projectDir = makeTempDir('ts-type-only-project-')
		const outputDir = makeTempDir('ts-type-only-output-')

		writeSinglePageProject(projectDir, 'ts-type-only-app', 'ts', `import type { PageData } from './types'
export type { PageData as RenamedPageData } from './types'
export { type PageInfo } from './types'
export type * from './types'

Page<PageData>({
  data: {
    count: 0,
  },
})
`)
		writePageFile(projectDir, 'pages/index/types.ts', `export type PageData = {
  count: number
}

export type PageInfo = {
  title: string
}
`)

		await build(outputDir, projectDir, true, { sourcemap: true })

		const logicPath = path.join(outputDir, 'ts-type-only-app', 'main', 'logic.js')
		const logicCode = fs.readFileSync(logicPath, 'utf8')

		expect(logicCode).not.toContain("modDefine('/pages/index/types'")
	})

	it('应该在 sourcemap 模式下保留 TS mixed import/export 的运行时依赖', async () => {
		const projectDir = makeTempDir('ts-mixed-import-project-')
		const outputDir = makeTempDir('ts-mixed-import-output-')

		writeSinglePageProject(projectDir, 'ts-mixed-import-app', 'ts', `import { pageValue, type PageData } from './values'
export { pageValue, type PageData } from './values'

Page<PageData>({
  data: {
    count: pageValue,
  },
})
`)
		writePageFile(projectDir, 'pages/index/values.ts', `export const pageValue = 1

export type PageData = {
  count: number
}
`)

		await build(outputDir, projectDir, true, { sourcemap: true })

		const logicPath = path.join(outputDir, 'ts-mixed-import-app', 'main', 'logic.js')
		const logicCode = fs.readFileSync(logicPath, 'utf8')

		expect(logicCode).toContain("modDefine('/pages/index/values'")
	})
})
