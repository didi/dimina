import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import build from '../src/index.js'

const perfCacheSpies = vi.hoisted(() => ({
	compileTemplateCalls: [],
	parseSyncCalls: [],
}))

vi.mock('@vue/compiler-sfc', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		compileTemplate(options) {
			perfCacheSpies.compileTemplateCalls.push(options.filename)
			return actual.compileTemplate(options)
		},
	}
})

vi.mock('oxc-parser', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		parseSync(...args) {
			perfCacheSpies.parseSyncCalls.push(args)
			return actual.parseSync(...args)
		},
	}
})

describe('templateRenderCache 命中路径 - 两页共享具名模板 + WXS 的完整链路', () => {
	let tempDir
	let originalTargetPath

	const cardWxml = [
		'<wxs src="./format.wxs" module="format" />',
		'<template name="card"><view class="card-marker">{{format.upper(\'x\')}}</view></template>',
		'',
	].join('\n')
	const formatWxs = 'module.exports = { upper: function (value) { return value } }'
	const pageWxml = [
		'<import src="../../templates/card" />',
		'<view><template is="card" /></view>',
		'<view>{{shared.expr.value}}</view>',
		'',
	].join('\n')

	function writeProjectFile(root, relativePath, content) {
		const fullPath = path.join(root, relativePath)
		fs.mkdirSync(path.dirname(fullPath), { recursive: true })
		fs.writeFileSync(fullPath, content)
	}

	function writeSharedTemplateProject(root) {
		writeProjectFile(root, 'app.json', JSON.stringify({ pages: ['pages/one/index', 'pages/two/index'] }))
		writeProjectFile(root, 'app.js', 'App({})\n')
		writeProjectFile(root, 'app.wxss', '')
		writeProjectFile(root, 'project.config.json', JSON.stringify({ appid: 'shared-template-cache-app' }))
		for (const name of ['one', 'two']) {
			writeProjectFile(root, `pages/${name}/index.json`, '{}')
			writeProjectFile(root, `pages/${name}/index.js`, 'Page({ data: {} })\n')
			writeProjectFile(root, `pages/${name}/index.wxml`, pageWxml)
			writeProjectFile(root, `pages/${name}/index.wxss`, '')
		}
		writeProjectFile(root, 'templates/card.wxml', cardWxml)
		writeProjectFile(root, 'templates/format.wxs', formatWxs)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		perfCacheSpies.compileTemplateCalls.length = 0
		perfCacheSpies.parseSyncCalls.length = 0
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-template-cache-'))
	})

	afterEach(() => {
		if (originalTargetPath) process.env.TARGET_PATH = originalTargetPath
		else delete process.env.TARGET_PATH
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('普通模式：两页产物与 WXS 注册一致，具名模板只真正编译一次（第二页命中缓存），依赖图两页都记录', async () => {
		writeSharedTemplateProject(tempDir)
		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { getDependencyGraph, getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)
		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const outputOne = fs.readFileSync(path.join(outputDir, 'main/pages_one_index.js'), 'utf8')
		const outputTwo = fs.readFileSync(path.join(outputDir, 'main/pages_two_index.js'), 'utf8')

		// 两页产物里共享具名模板的 render 代码必须一致，且都正确注册了模板引用的 WXS 模块
		expect(outputOne).toContain('card-marker')
		expect(outputTwo).toContain('card-marker')
		expect(outputOne).toContain('templates_format')
		expect(outputTwo).toContain('templates_format')

		// 共享具名模板的 compileTemplate 只应该被真正调用一次：第二页命中 templateRenderCache
		const cardCompileCalls = perfCacheSpies.compileTemplateCalls.filter(filename => filename === 'tpl-card')
		expect(cardCompileCalls).toHaveLength(1)

		// 两个页面都包含同一表达式；第二次转换必须复用 optionalChainingCache。
		const sharedExpressionParseCalls = perfCacheSpies.parseSyncCalls.filter(
			([filename, code]) => filename === 'view-compiler.js' && code === '(shared.expr.value)',
		)
		expect(sharedExpressionParseCalls).toHaveLength(1)

		// 依赖图对两页都记录了对共享模板文件的依赖，不因命中缓存而漏记
		const graph = getDependencyGraph()
		const affected = graph.getAffectedEntries(path.join(tempDir, 'templates/card.wxml'))
		expect(affected).toEqual(expect.arrayContaining(['pages/one/index', 'pages/two/index']))
	})

	it('sourcemap 模式：两页各自的 source map 都正确回指共享模板源码，不因缓存复用而错位或串页', async () => {
		writeSharedTemplateProject(tempDir)
		const outputDir = path.join(tempDir, 'out')

		await build(outputDir, tempDir, false, { sourcemap: true })

		const cardSource = '/templates/card.wxml'
		const expectedSourceLine = cardWxml.split('\n').findIndex(line => line.includes('format.upper')) + 1

		for (const pageName of ['one', 'two']) {
			const viewPath = path.join(outputDir, `main/pages_${pageName}_index.js`)
			const mapPath = `${viewPath}.map`
			expect(fs.existsSync(mapPath)).toBe(true)

			const viewCode = fs.readFileSync(viewPath, 'utf8')
			const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
			expect(map.sources).toContain(cardSource)
			expect(map.sourcesContent[map.sources.indexOf(cardSource)]).toBe(cardWxml)

			const lines = viewCode.split('\n')
			const wxsCallLine = lines.findIndex(line => line.includes('.upper(')) + 1
			expect(wxsCallLine).toBeGreaterThan(0)

			const consumer = new SourceMapConsumer(map)
			const position = consumer.originalPositionFor({
				line: wxsCallLine,
				column: lines[wxsCallLine - 1].indexOf('.upper('),
			})
			// 命中缓存的页面拿到的是另一页编译时生成的 map 片段，拼接进各自产物后
			// 仍必须回指共享模板自身的源文件与源码行，不能残留另一页的坐标
			expect(position.source).toBe(cardSource)
			expect(position.line).toBe(expectedSourceLine)
		}
	})
})
