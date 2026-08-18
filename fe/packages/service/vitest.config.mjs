import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const commonSourceRoot = resolve(packageRoot, '../common/src')

export default defineConfig({
	resolve: {
		alias: {
			'@dimina/common': resolve(commonSourceRoot, 'index.js'),
			'@': resolve(packageRoot, 'src'),
		},
	},
	test: {
		globals: true,
		setupFiles: ['./__tests__/test-setup.js'],
	}
})
