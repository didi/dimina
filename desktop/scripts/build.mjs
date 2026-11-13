import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const project = join(root, 'desktop')
const args = process.argv.slice(2)
const platformArg = args.find(arg => arg.startsWith('--platform='))
const outputArg = args.find(arg => arg.startsWith('--out='))
const output = outputArg ? resolve(outputArg.slice('--out='.length)) : join(project, 'build')
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
run(process.execPath, [join(project, 'scripts/sync-mobile-apis.mjs'), '--check'])
run('pnpm', ['--filter', '@dimina/desktop...', 'build'], join(root, 'fe'))
// Package the BLE helper as a native resource before MyGo signs and archives it.
const [os, architecture] = target.split('/')
if (architecture === 'universal' && os !== 'darwin') throw new Error('Universal builds require macOS')
for (const arch of architecture === 'universal' ? ['arm64', 'amd64'] : [architecture]) {
    const rustTarget = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${{ darwin: 'apple-darwin', windows: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[os]}`
    const targetDir = join(root, '.build/device-bridge-target')
    const previousTarget = env.CARGO_TARGET_DIR
    env.CARGO_TARGET_DIR = targetDir
    run('cargo', ['build', '--release', '--locked', '--manifest-path', join(project, 'device-bridge/Cargo.toml'), '--target', rustTarget])
    if (previousTarget === undefined) delete env.CARGO_TARGET_DIR
    else env.CARGO_TARGET_DIR = previousTarget
    const file = `dimina-device-bridge${os === 'windows' ? '.exe' : ''}`
    const resources = join(project, 'resources', `${os}-${arch}`)
    mkdirSync(resources, { recursive: true })
    copyFileSync(join(targetDir, rustTarget, 'release', file), join(resources, file))
    if (os !== 'windows') chmodSync(join(resources, file), 0o755)
}

run(go, ['run', 'github.com/egoist/mygo/cmd/mygo@v0.9.0', 'build', '-platform', target, '-skip-dmg', '-skip-installer', '-o', output])
console.log(`Desktop build: ${join(output, target.replace('/', '-'))}`)
