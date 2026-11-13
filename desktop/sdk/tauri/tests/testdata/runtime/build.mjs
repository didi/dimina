import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function buildTestRuntime(output) {
  const source = dirname(fileURLToPath(import.meta.url))
  const localGo = resolve(source, '../../../../../../.build/toolchains/go/bin/go' + (process.platform === 'win32' ? '.exe' : ''))
  const go = process.env.GO_BIN || (existsSync(localGo) ? localGo : 'go')
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync(go, ['build', '-o', output, 'main.go', `process_${process.platform === 'win32' ? 'windows' : 'unix'}.go`], { cwd: source, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Could not build native SDK test fixture')
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = process.argv.indexOf('--out')
  if (option < 0 || !process.argv[option + 1]) throw new Error('Usage: build.mjs --out ABSOLUTE_EXECUTABLE')
  buildTestRuntime(resolve(process.argv[option + 1]))
}
