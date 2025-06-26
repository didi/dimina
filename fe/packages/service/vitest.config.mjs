import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'@': resolve(process.cwd(), 'src'),
		},
	},
	test: {
		globals: true,
		setupFiles: ['./__tests__/test-setup.js']
	}
}) 
