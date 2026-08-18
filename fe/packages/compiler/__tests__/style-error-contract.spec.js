import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.resolve(testDir, '../src/bin/index.js')

describe('style error contract', () => {
	const tempDirs = []

	afterEach(() => {
		for (const tempDir of tempDirs) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
		tempDirs.length = 0
	})

	function createProject(extension, styleSource) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-error-contract-'))
		tempDirs.push(tempDir)
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')
		const pageDir = path.join(workDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		fs.mkdirSync(outputDir)
		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: `style-error-${extension}`,
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), '{}')
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.json'), '{}')
		fs.writeFileSync(path.join(pageDir, 'index.wxml'), '<view class="page" />\n')
		fs.writeFileSync(path.join(pageDir, `index.${extension}`), styleSource)
		return { outputDir, workDir }
	}

	it.each([
		['less', '.page {\n  color: @missing;\n}\n', 'preprocess', 2],
		['scss', '.page {\n  color: $missing;\n}\n', 'preprocess', 2],
		['wxss', '.page: {\n  color: red;\n}\n', 'transform', 1],
		['wxss', '.page {\n  color: red;\n', 'transform', 1],
	])('rejects invalid %s instead of emitting partial CSS', async (extension, source, stage, line) => {
		const { outputDir, workDir } = createProject(extension, source)
		let error
		try {
			await build(outputDir, workDir, false)
		}
		catch (caught) {
			error = caught
		}

		expect(error).toMatchObject({
			name: 'StyleCompileError',
			file: `/pages/index/index.${extension}`,
			line,
			stage,
		})
		expect(error.message).toContain(`[style:${stage}] /pages/index/index.${extension}:${line}`)
		expect(fs.existsSync(path.join(outputDir, 'main/pages_index_index.css'))).toBe(false)
	})

	it('returns a non-zero CLI status with the original style location', () => {
		const { outputDir, workDir } = createProject('wxss', '.page {\n  color: red;\n')
		const result = spawnSync(process.execPath, [
			cliPath,
			'build',
			'--work-path',
			workDir,
			'--target-path',
			outputDir,
			'--no-app-id-dir',
		], {
			encoding: 'utf8',
			env: {
				...process.env,
				NO_COLOR: '1',
			},
		})

		expect(result.status).toBe(1)
		expect(result.stderr).toContain(`${workDir} 编译出错`)
		expect(result.stderr).toContain('[style:transform] /pages/index/index.wxss:1:1')
		expect(result.stderr).toContain('Unclosed block')
	})
})
