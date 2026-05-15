import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build, mergeConfig } from 'vite'
import viteConfig from '../vite.config.mjs'

describe('compiler build output', () => {
	let outDir = null

	afterEach(() => {
		if (outDir && fs.existsSync(outDir)) {
			fs.rmSync(outDir, { recursive: true, force: true })
		}
	})

	it('esm 产物不应为 Babel 依赖保留运行时 require 调用', async () => {
		outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-compiler-build-'))

		await build(mergeConfig(viteConfig, {
			logLevel: 'silent',
			build: {
				outDir,
				emptyOutDir: true,
			},
		}))

		const viewCompilerPath = path.join(outDir, 'core/view-compiler.js')
		const output = fs.readFileSync(viewCompilerPath, 'utf-8')

		expect(output).not.toMatch(/require\(["']@babel\/core["']\)/)
		expect(output).not.toMatch(/require\(["']@babel\/traverse["']\)/)
		expect(output).not.toMatch(/require\(["']@babel\/types["']\)/)
		expect(output).not.toMatch(/require\(["']@babel\/plugin-transform-modules-commonjs["']\)/)
	}, 120000)
})
