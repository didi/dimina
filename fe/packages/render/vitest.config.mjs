import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

function resolveFile(base) {
	const candidates = [
		base,
		`${base}.js`,
		`${base}.vue`,
		resolve(base, 'index.js'),
		resolve(base, 'index.vue'),
	]

	return candidates.find(path => existsSync(path))
}

function resolveWorkspaceAlias(source, importer, cwd) {
	if (source.startsWith('@/')) {
		if (importer?.includes('/packages/common/src/')) {
			return resolveFile(resolve(cwd, '../common/src', source.slice(2)))
		}
		if (importer?.includes('/packages/components/src/')) {
			return resolveFile(resolve(cwd, '../components/src', source.slice(2)))
		}
		return resolveFile(resolve(cwd, 'src', source.slice(2)))
	}

	if (source.startsWith('@component/')) {
		return resolveFile(resolve(cwd, '../components/src/component', source.slice('@component/'.length)))
	}
}

export default defineConfig({
	plugins: [
		vue(),
		{
			name: 'dimina-workspace-source-alias',
			enforce: 'pre',
			resolveId(source, importer) {
				return resolveWorkspaceAlias(source, importer, process.cwd())
			},
		},
	],
	resolve: {
		alias: {
			'@dimina/common': resolve(process.cwd(), '../common/src/index.js'),
			'@dimina/components': resolve(process.cwd(), '../components/src/index.js'),
		},
	},
	test: {
		environment: 'jsdom',
		globals: true,
	},
})
