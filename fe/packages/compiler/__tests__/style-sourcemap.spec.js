import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

describe('style sourcemap', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-sourcemap-'))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('maps imported, page, and component CSS back to their WXSS sources', async () => {
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')
		const pageDir = path.join(workDir, 'pages/index')
		const componentDir = path.join(workDir, 'components/card')
		fs.mkdirSync(pageDir, { recursive: true })
		fs.mkdirSync(componentDir, { recursive: true })

		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: 'style-sourcemap-app',
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), JSON.stringify({
			appid: 'style-sourcemap-app',
		}))
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.json'), JSON.stringify({
			usingComponents: {
				card: '../../components/card/index',
			},
		}))
		fs.writeFileSync(path.join(pageDir, 'index.wxml'), '<view class="page"><card /></view>\n')

		const pageWxss = [
			'@import "./shared.wxss";',
			'.page {',
			'  color: rgb(1, 2, 3);',
			'}',
			'',
		].join('\n')
		const importedWxss = [
			'.shared {',
			'  margin: 75rpx;',
			'}',
			'',
		].join('\n')
		fs.writeFileSync(path.join(pageDir, 'index.wxss'), pageWxss)
		fs.writeFileSync(path.join(pageDir, 'shared.wxss'), importedWxss)

		fs.writeFileSync(path.join(componentDir, 'index.js'), 'Component({})\n')
		fs.writeFileSync(path.join(componentDir, 'index.json'), JSON.stringify({ component: true }))
		fs.writeFileSync(path.join(componentDir, 'index.wxml'), '<view class="card" />\n')
		const componentWxss = [
			'.card {',
			'  padding: 150rpx;',
			'}',
			'',
		].join('\n')
		fs.writeFileSync(path.join(componentDir, 'index.wxss'), componentWxss)

		await build(outputDir, workDir, false, { sourcemap: true })

		const cssPath = path.join(outputDir, 'main/pages_index_index.css')
		const mapPath = `${cssPath}.map`
		expect(fs.existsSync(cssPath)).toBe(true)
		expect(fs.existsSync(mapPath)).toBe(true)

		const css = fs.readFileSync(cssPath, 'utf8')
		expect(css).toContain('sourceMappingURL=pages_index_index.css.map')
		const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
		const pageSource = '/pages/index/index.wxss'
		const importedSource = '/pages/index/shared.wxss'
		const componentSource = '/components/card/index.wxss'
		expect(map.sources).toEqual(expect.arrayContaining([pageSource, importedSource, componentSource]))
		expect(map.sourcesContent[map.sources.indexOf(pageSource)]).toBe(pageWxss)
		expect(map.sourcesContent[map.sources.indexOf(importedSource)]).toBe(importedWxss)
		expect(map.sourcesContent[map.sources.indexOf(componentSource)]).toBe(componentWxss)

		const consumer = new SourceMapConsumer(map)
		for (const [token, source, line] of [
			['margin:10vw', importedSource, 2],
			['color:#010203', pageSource, 3],
			['padding:20vw', componentSource, 2],
		]) {
			const offset = css.indexOf(token)
			expect(offset, `missing generated CSS token: ${token}\n${css}`).toBeGreaterThanOrEqual(0)
			const before = css.slice(0, offset)
			const generatedLine = before.split('\n').length
			const generatedColumn = offset - (before.lastIndexOf('\n') + 1)
			const original = consumer.originalPositionFor({
				line: generatedLine,
				column: generatedColumn,
			})
			expect(original.source).toBe(source)
			expect(original.line).toBe(line)
		}
	})

	it.each([
		['less', '@space: 75rpx;\n.page {\n  padding: @space;\n}\n'],
		['scss', '$space: 75rpx;\n.page {\n  padding: $space;\n}\n'],
	])('preserves original %s source locations through preprocessing', async (extension, source) => {
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')
		const pageDir = path.join(workDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: `style-sourcemap-${extension}`,
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), '{}')
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.json'), '{}')
		fs.writeFileSync(path.join(pageDir, 'index.wxml'), '<view class="page" />\n')
		fs.writeFileSync(path.join(pageDir, `index.${extension}`), source)

		await build(outputDir, workDir, false, { sourcemap: true })

		const cssPath = path.join(outputDir, 'main/pages_index_index.css')
		const css = fs.readFileSync(cssPath, 'utf8')
		const map = JSON.parse(fs.readFileSync(`${cssPath}.map`, 'utf8'))
		const sourcePath = `/pages/index/index.${extension}`
		expect(map.sources).toContain(sourcePath)
		expect(map.sourcesContent[map.sources.indexOf(sourcePath)]).toBe(source)

		const offset = css.indexOf('padding:10vw')
		expect(offset).toBeGreaterThanOrEqual(0)
		const before = css.slice(0, offset)
		const original = new SourceMapConsumer(map).originalPositionFor({
			line: before.split('\n').length,
			column: offset - (before.lastIndexOf('\n') + 1),
		})
		expect(original.source).toBe(sourcePath)
		expect(original.line).toBe(3)
	})
})
