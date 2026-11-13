import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const project = join(root, 'desktop')
const args = process.argv.slice(2)
const platformArg = args.find(arg => arg.startsWith('--platform='))
const target = platformArg?.slice('--platform='.length) || `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`
if (!/^(darwin|windows|linux)\/(arm64|amd64|universal)$/.test(target)) throw new Error(`Unsupported platform: ${target}`)
const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, GOTOOLCHAIN: 'local' }
const go = process.env.GO_BIN || (existsSync(join(root, '.build/toolchains/go/bin/go')) ? join(root, '.build/toolchains/go/bin/go') : 'go')

function run(command, argv, cwd = project) {
	const result = spawnSync(command, argv, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command === 'pnpm' })
	if (result.error) throw result.error
	if (result.status !== 0) process.exit(result.status || 1)
}

run(go, ['version'])
run('pnpm', ['--filter', '@dimina/desktop...', 'build'], join(root, 'fe'))
run(go, ['run', 'github.com/egoist/mygo/cmd/mygo@v0.9.0', 'build', '-platform', target, '-skip-dmg', '-skip-installer'])
console.log(`Desktop build: ${join(project, 'build', target.replace('/', '-'))}`)
