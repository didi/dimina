import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('prepared pixels validate every input byte, bound weak entries and isolate concurrent owners', () => {
	const directory = mkdtempSync(join(tmpdir(), 'dimina-prepared-pixels-'))
	try {
		const fixture = fileURLToPath(new URL('./fixtures/canvas-prepared-pixels.cpp', import.meta.url))
		const includes = fileURLToPath(new URL('../dimina/src/main/cpp/', import.meta.url))
		const executable = join(directory, 'prepared-pixels')
		const build = spawnSync(process.env.CXX ?? 'c++', [
			'-std=c++17', '-O2', '-pthread', '-Wall', '-Wextra', '-Werror', '-I', includes, fixture, '-o', executable,
		], { encoding: 'utf8', timeout: 30000 })
		assert.equal(build.status, 0, build.stderr || build.error?.message)
		const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 })
		assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
		assert.match(result.stdout, /PASS exact runs\/literals, mutations, malformed packets, weak lifetimes, cache bound, threads/)
	} finally { rmSync(directory, { recursive: true, force: true }) }
})
