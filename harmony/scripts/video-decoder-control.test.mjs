import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('the native start generation prevents activation after stop and permits restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-video-control-'))
  try {
    const fixture = fileURLToPath(new URL('./fixtures/video-decoder-control.cpp', import.meta.url))
    const includes = fileURLToPath(new URL('../dimina/src/main/cpp/', import.meta.url))
    const executable = path.join(directory, 'video-decoder-control')
    const compile = spawnSync(process.env.CXX ?? 'c++', ['-std=c++17', '-pthread', '-I', includes, fixture, '-o', executable], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
