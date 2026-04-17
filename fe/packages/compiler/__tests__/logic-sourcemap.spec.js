import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SourceMapConsumer } from 'source-map-js'
import build from '../src/index.js'

describe('logic sourcemap', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-sourcemap-'))
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('should preserve TypeScript source content in logic.js.map', async () => {
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')

		fs.mkdirSync(path.join(workDir, 'pages/index'), { recursive: true })
		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: 'test-app-id',
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({});\n')
		fs.writeFileSync(path.join(workDir, 'pages/index/index.json'), JSON.stringify({}))
		fs.writeFileSync(path.join(workDir, 'pages/index/index.wxml'), '<view>hello</view>\n')
		fs.writeFileSync(path.join(workDir, 'pages/index/helper.ts'), [
			'export const helper = "ok"',
			'',
		].join('\n'))
		fs.writeFileSync(path.join(workDir, 'pages/index/index.ts'), [
			'import { helper } from "./helper"',
			'interface PageData {',
			'\tmsg: string',
			'}',
			'const value: number = 1',
			'Page<PageData>({',
			'\tdata: { msg: "hi" },',
			'\tonLoad(): void {',
			'\t\tconsole.log(helper, value)',
			'\t}',
			'})',
			'',
		].join('\n'))

		await build(outputDir, workDir, false, { sourcemap: true })

		const logicPath = path.join(outputDir, 'main/logic.js')
		const sourcemapPath = path.join(outputDir, 'main/logic.js.map')

		expect(fs.existsSync(logicPath)).toBe(true)
		expect(fs.existsSync(sourcemapPath)).toBe(true)

		const logicCode = fs.readFileSync(logicPath, 'utf-8')
		expect(logicCode).toContain('sourceMappingURL=logic.js.map')

		const sourcemap = JSON.parse(fs.readFileSync(sourcemapPath, 'utf-8'))
		const sourceIndex = sourcemap.sources.indexOf('/pages/index/index.ts')
		expect(sourceIndex).toBeGreaterThan(-1)
		expect(sourcemap.sourcesContent[sourceIndex]).toContain('import { helper } from "./helper"')
		expect(sourcemap.sourcesContent[sourceIndex]).toContain('const value: number = 1')
		expect(sourcemap.sourcesContent[sourceIndex]).toContain('Page<PageData>({')
		expect(sourcemap.sourcesContent[sourceIndex]).not.toContain('from "/pages/index/helper"')
		expect(sourcemap.sourcesContent[sourceIndex]).not.toContain('"use strict"')

		const importLine = logicCode.split('\n').findIndex(line => line.includes('require("/pages/index/helper")')) + 1
		expect(importLine).toBeGreaterThan(0)
		const valueLine = logicCode.split('\n').findIndex(line => line.includes('const value = 1;')) + 1
		expect(valueLine).toBeGreaterThan(0)

		const smc = new SourceMapConsumer(sourcemap)
		const importPos = smc.originalPositionFor({ line: importLine, column: 0 })
		const valuePos = smc.originalPositionFor({ line: valueLine, column: 0 })

		expect(importPos.source).toBe('/pages/index/index.ts')
		expect(importPos.line).toBe(1)
		expect(valuePos.source).toBe('/pages/index/index.ts')
		expect(valuePos.line).toBe(5)
	})
})
