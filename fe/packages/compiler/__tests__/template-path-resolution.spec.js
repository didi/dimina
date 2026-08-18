import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('mini-program template path resolution', () => {
	let tempDir
	let originalTargetPath
	let compileIndex = 0

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-path-resolution-'))
	})

	afterEach(() => {
		if (originalTargetPath) process.env.TARGET_PATH = originalTargetPath
		else delete process.env.TARGET_PATH
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function compileProject(pageTemplate, files) {
		const pagePath = `pages/index-${compileIndex++}`
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: [pagePath],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'template-path-resolution',
		}))
		fs.mkdirSync(path.join(tempDir, 'pages'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, `${pagePath}.json`), '{}')
		fs.writeFileSync(path.join(tempDir, `${pagePath}.wxml`), pageTemplate)

		for (const [relativePath, content] of Object.entries(files)) {
			const filePath = path.join(tempDir, relativePath)
			fs.mkdirSync(path.dirname(filePath), { recursive: true })
			fs.writeFileSync(filePath, content)
		}

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)
		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })
		return fs.readFileSync(path.join(outputDir, `main/${pagePath.replace(/\//g, '_')}.js`), 'utf8')
	}

	it('resolves an extensionless import and its local WXS from the imported file', async () => {
		const output = await compileProject(`
			<import src="../templates/card" />
			<template is="card" data="{{ class: cardClass, text: title }}" />
		`, {
			'templates/card.wxml': `
				<wxs src="./format.wxs" module="format" />
				<template name="card"><view class="{{class}} {{classPrefix}}">{{format.label(text)}}</view></template>
			`,
			'templates/format.wxs': 'module.exports = { label: function (value) { return value } }',
		})

		expect(output).toContain('tpl-card')
		expect(output).toContain('templates_format')
		expect(output).toContain('.class')
		expect(output).not.toContain('__dimina_reserved_class')
	})

	it('resolves an extensionless include and its local WXS from the included file', async () => {
		const output = await compileProject(`
			<include src="../partials/content" />
		`, {
			'partials/content.wxml': `
				<wxs src="./format.wxs" module="format" />
				<view>{{format.label(title)}}</view>
			`,
			'partials/format.wxs': 'module.exports = { label: function (value) { return value } }',
		})

		expect(output).toContain('partials_format')
		expect(output).not.toContain('<include')
	})
})
