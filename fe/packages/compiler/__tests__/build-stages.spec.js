import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

describe('dependency-directed compiler stages', () => {
	let tempDir
	let outputDir
	const pagePath = 'pages/index/index'

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-stages-'))
		outputDir = path.join(tempDir, 'out')
		writeFile('app.json', JSON.stringify({ pages: [pagePath] }))
		writeFile('app.js', 'App({})\n')
		writeFile('app.wxss', '')
		writeFile('project.config.json', JSON.stringify({ appid: 'build-stages-app' }))
		writeFile(`${pagePath}.json`, '{}')
		writeFile(`${pagePath}.js`, 'Page({ data: { value: 1 } })\n')
		writeFile(`${pagePath}.wxml`, '<view>initial view</view>\n')
		writeFile(`${pagePath}.wxss`, '.page { color: red; }\n')
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function writeFile(relativePath, content) {
		const filePath = path.join(tempDir, relativePath)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, content)
	}

	function readOutput(relativePath) {
		return fs.readFileSync(path.join(outputDir, relativePath), 'utf8')
	}

	function incrementalOptions(result, stages) {
		return {
			affectedEntries: [pagePath],
			stages,
			seedPath: outputDir,
			dependencyGraph: result.dependencyGraph,
		}
	}

	it('rejects unknown compiler stages instead of silently dropping work', async () => {
		await expect(build(outputDir, tempDir, false, { stages: ['unknown'] }))
			.rejects.toThrow('Invalid compiler stages')
	})

	it('runs only the requested view, logic, and style stages while retaining seeded outputs', async () => {
		let result = await build(outputDir, tempDir, false)
		let viewOutput = readOutput('main/pages_index_index.js')
		let logicOutput = readOutput('main/logic.js')
		let styleOutput = readOutput('main/pages_index_index.css')

		writeFile(`${pagePath}.wxml`, '<view>view stage changed</view>\n')
		writeFile(`${pagePath}.js`, 'Page({')
		writeFile(`${pagePath}.wxss`, '.broken {')
		result = await build(outputDir, tempDir, false, incrementalOptions(result, ['view']))
		const viewOnlyOutput = readOutput('main/pages_index_index.js')
		expect(viewOnlyOutput).toContain('view stage changed')
		expect(readOutput('main/logic.js')).toBe(logicOutput)
		expect(readOutput('main/pages_index_index.css')).toBe(styleOutput)
		viewOutput = viewOnlyOutput

		writeFile(`${pagePath}.js`, 'Page({ data: { value: 2 } })\n')
		fs.rmSync(path.join(tempDir, `${pagePath}.wxml`))
		fs.mkdirSync(path.join(tempDir, `${pagePath}.wxml`))
		result = await build(outputDir, tempDir, false, incrementalOptions(result, ['logic']))
		const logicOnlyOutput = readOutput('main/logic.js')
		expect(logicOnlyOutput).not.toBe(logicOutput)
		expect(readOutput('main/pages_index_index.js')).toBe(viewOutput)
		expect(readOutput('main/pages_index_index.css')).toBe(styleOutput)
		logicOutput = logicOnlyOutput

		writeFile(`${pagePath}.js`, 'Page({')
		writeFile(`${pagePath}.wxss`, '.page { color: blue; }\n')
		result = await build(outputDir, tempDir, false, incrementalOptions(result, ['style']))
		const styleOnlyOutput = readOutput('main/pages_index_index.css')
		expect(styleOnlyOutput).toContain('blue')
		expect(styleOnlyOutput).not.toBe(styleOutput)
		expect(readOutput('main/pages_index_index.js')).toBe(viewOutput)
		expect(readOutput('main/logic.js')).toBe(logicOutput)
	})
})
