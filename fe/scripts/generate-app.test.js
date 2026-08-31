const assert = require('node:assert/strict')
const { mkdtemp, mkdir, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const sourceFePath = path.resolve(__dirname, '..')

test('generate-app fails when an app zip cannot be created', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'dimina-generate-app-'))
	t.after(() => rm(root, { recursive: true, force: true }))

	const fixtureFePath = path.join(root, 'fe')
	const appPath = path.join(fixtureFePath, 'packages/container/public/wx-test/main')
	const sharedAppPath = path.join(root, 'shared/jsapp/wx-test')
	await mkdir(appPath, { recursive: true })
	await mkdir(sharedAppPath, { recursive: true })
	await writeFile(path.join(appPath, 'app-config.json'), JSON.stringify({ app: { pages: ['index'] }, projectName: 'Test' }))
	await mkdir(path.join(sharedAppPath, 'wx-test.zip'))
	await mkdir(path.join(fixtureFePath, 'scripts'), { recursive: true })
	await symlink(path.join(sourceFePath, 'node_modules'), path.join(fixtureFePath, 'node_modules'))
	await writeFile(path.join(fixtureFePath, 'scripts/generate-app.js'), await require('node:fs/promises').readFile(path.join(__dirname, 'generate-app.js')))

	const result = spawnSync(process.execPath, [path.join(fixtureFePath, 'scripts/generate-app.js')], { encoding: 'utf8' })

	assert.notEqual(result.status, 0)
	assert.match(result.stderr, /Failed to create zip for: wx-test/)
	assert.doesNotMatch(result.stdout, /Successfully created .*wx-test\.zip/)
	assert.doesNotMatch(result.stdout, /App generation completed successfully/)
})
