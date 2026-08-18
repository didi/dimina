import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.resolve(testDir, '../src/bin/index.js')

describe('compiler build error contract', () => {
	const tempDirs = []

	afterEach(() => {
		for (const tempDir of tempDirs) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
		tempDirs.length = 0
	})

	function createMissingWorkPath() {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-build-error-'))
		tempDirs.push(tempDir)
		return path.join(tempDir, 'missing-app')
	}

	it('rejects the programmatic build when project initialization fails', async () => {
		const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-build-output-'))
		tempDirs.push(outputDir)

		await expect(build(outputDir, createMissingWorkPath(), false)).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})

	it('returns a non-zero CLI status when compilation fails', () => {
		const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-cli-output-'))
		tempDirs.push(outputDir)
		const workPath = createMissingWorkPath()

		const result = spawnSync(process.execPath, [
			cliPath,
			'build',
			'--work-path',
			workPath,
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
		expect(result.stderr).toContain(`${workPath} 编译出错`)
	})
})
