import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
test('native binary packets own bytes and serialize readiness/fallback without replay', () => {
	const output = mkdtempSync(join(tmpdir(), 'dimina-canvas-binary-'))
	try {
		const binary = join(output, 'channel')
		const compile = spawnSync(process.env.CXX ?? 'c++', ['-std=c++17', '-O2', '-UNDEBUG', '-pthread', '-Wall', '-Wextra', '-Werror',
			'-I', fileURLToPath(new URL('../dimina/src/main/cpp', import.meta.url)),
			fileURLToPath(new URL('./fixtures/canvas-binary-channel.cpp', import.meta.url)), '-o', binary], { encoding: 'utf8' })
		assert.equal(compile.status, 0, compile.stderr || compile.error?.message)
		const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 })
		assert.equal(result.status, 0, result.stdout + result.stderr)
		assert.match(result.stdout, /PASS/)
	} finally { rmSync(output, { recursive: true, force: true }) }
})
