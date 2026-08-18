import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

describe('view sourcemap', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-sourcemap-'))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('maps page and component render expressions back to their WXML sources', async () => {
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')
		const pageDir = path.join(workDir, 'pages/index')
		const componentDir = path.join(workDir, 'components/card')
		fs.mkdirSync(pageDir, { recursive: true })
		fs.mkdirSync(componentDir, { recursive: true })

		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: 'view-sourcemap-app',
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), JSON.stringify({
			appid: 'view-sourcemap-app',
		}))
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({ data: { pageMessage: "hello" } })\n')
		fs.writeFileSync(path.join(pageDir, 'index.json'), JSON.stringify({
			usingComponents: {
				card: '../../components/card/index',
			},
		}))
		const pageWxml = [
			'<wxs module="fmt">module.exports.upper = function (value) { return value }</wxs>',
			'<view>',
			'  <text>{{fmt.upper(pageMessage)}}</text>',
			'  <card value="{{pageMessage}}" />',
			'</view>',
			'',
		].join('\n')
		fs.writeFileSync(path.join(pageDir, 'index.wxml'), pageWxml)

		fs.writeFileSync(path.join(componentDir, 'index.js'), 'Component({ properties: { value: String } })\n')
		fs.writeFileSync(path.join(componentDir, 'index.json'), JSON.stringify({ component: true }))
		const componentWxml = [
			'<view>',
			'  <text>{{value}}</text>',
			'</view>',
			'',
		].join('\n')
		fs.writeFileSync(path.join(componentDir, 'index.wxml'), componentWxml)

		await build(outputDir, workDir, false, { sourcemap: true })

		const viewPath = path.join(outputDir, 'main/pages_index_index.js')
		const mapPath = `${viewPath}.map`
		expect(fs.existsSync(viewPath)).toBe(true)
		expect(fs.existsSync(mapPath)).toBe(true)

		const viewCode = fs.readFileSync(viewPath, 'utf8')
		expect(viewCode).toContain('sourceMappingURL=pages_index_index.js.map')
		const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
		const pageSource = '/pages/index/index.wxml'
		const componentSource = '/components/card/index.wxml'
		expect(map.sources).toContain(pageSource)
		expect(map.sources).toContain(componentSource)
		expect(map.sourcesContent[map.sources.indexOf(pageSource)]).toBe(pageWxml)
		expect(map.sourcesContent[map.sources.indexOf(componentSource)]).toBe(componentWxml)

		const lines = viewCode.split('\n')
		const pageLine = lines.findIndex(line => line.includes('__wxs_0?.upper(_ctx.pageMessage)')) + 1
		const componentLine = lines.findIndex(line => line.includes('_ctx.value')) + 1
		expect(pageLine).toBeGreaterThan(0)
		expect(componentLine).toBeGreaterThan(0)

		const consumer = new SourceMapConsumer(map)
		const pagePosition = consumer.originalPositionFor({
			line: pageLine,
			column: lines[pageLine - 1].indexOf('__wxs_0'),
		})
		const componentPosition = consumer.originalPositionFor({
			line: componentLine,
			column: lines[componentLine - 1].indexOf('_ctx.value'),
		})
		expect(pagePosition.source).toBe(pageSource)
		expect(pagePosition.line).toBe(3)
		expect(componentPosition.source).toBe(componentSource)
		expect(componentPosition.line).toBe(2)
	})
})
