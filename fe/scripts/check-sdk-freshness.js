#!/usr/bin/env node

// Guards against the exact failure that shipped a broken connectSocket/SocketTask
// fail & complete callback to production: fe/packages source changed, but nobody
// re-ran `pnpm generate:sdk`, so shared/jssdk/main.zip (the artifact devices
// actually load) stayed stale.
//
// This does not rebuild or diff the artifact's bytes — generate-sdk.js needs a
// full `container` build to do that, and its own version bump in config.json
// would make a byte-diff meaningless without extra bookkeeping anyway. Instead
// it checks a cheaper, still-real signal: if a pull request touches source that
// feeds the bundled SDK, the PR must also touch shared/jssdk/main.zip and
// shared/jssdk/config.json, proving someone actually re-ran the generator.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')

// Packages that `pnpm --filter container build` bundles into
// packages/container/dist/assets, which generate-sdk.js zips as main.zip.
const watchedPrefixes = [
	'fe/packages/container/src/',
	'fe/packages/common/src/',
	'fe/packages/components/src/',
	'fe/packages/render/src/',
	'fe/packages/service/src/',
	'fe/scripts/generate-sdk.js',
]

const sdkArtifactPaths = new Set([
	'shared/jssdk/main.zip',
	'shared/jssdk/config.json',
])

function git(args) {
	return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim()
}

function resolveBaseRef() {
	const candidates = [
		process.argv[2],
		process.env.SDK_FRESHNESS_BASE_REF,
		process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
		'origin/main',
		'main',
	].filter(Boolean)

	for (const candidate of candidates) {
		try {
			git(['rev-parse', '--verify', candidate])
			return candidate
		}
		catch {
			// try the next candidate
		}
	}
	return null
}

function main() {
	const baseRef = resolveBaseRef()
	if (!baseRef) {
		console.warn('[check-sdk-freshness] Could not resolve a base ref to diff against (tried CLI arg, SDK_FRESHNESS_BASE_REF, GITHUB_BASE_REF, origin/main, main). Skipping.')
		return
	}

	let mergeBase
	try {
		mergeBase = git(['merge-base', 'HEAD', baseRef])
	}
	catch (error) {
		console.warn(`[check-sdk-freshness] Could not compute a merge base against "${baseRef}": ${error.message}. Skipping.`)
		return
	}

	const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD'])
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)

	const changedSourceFiles = changedFiles.filter(file =>
		watchedPrefixes.some(prefix => file === prefix || file.startsWith(prefix)))

	if (changedSourceFiles.length === 0) {
		console.log('[check-sdk-freshness] No changes to sources bundled into shared/jssdk. Nothing to check.')
		return
	}

	// 必须两个都动过。generate-sdk.js 一定同时重写 main.zip 和 config.json；只改
	// config.json 里的版本号就能过关的话，正好放走了这个脚本要拦的那种 stale SDK。
	const changedSet = new Set(changedFiles)
	const sdkArtifactChanged = [...sdkArtifactPaths].every(file => changedSet.has(file))
	if (sdkArtifactChanged) {
		console.log('[check-sdk-freshness] shared/jssdk artifacts were updated alongside the source changes. OK.')
		return
	}

	console.error('[check-sdk-freshness] This change touches source that feeds shared/jssdk/main.zip, but shared/jssdk/main.zip and shared/jssdk/config.json were not regenerated:')
	for (const file of changedSourceFiles) {
		console.error(`  - ${file}`)
	}
	console.error('')
	console.error('Run `pnpm build` then `pnpm generate:sdk` from fe/, and commit the updated shared/jssdk/main.zip and shared/jssdk/config.json.')
	process.exitCode = 1
}

main()
