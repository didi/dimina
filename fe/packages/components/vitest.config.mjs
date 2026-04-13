import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'@': resolve(process.cwd(), 'src'),
			'@component': resolve(process.cwd(), 'src/component'),
		},
	},
	test: {
		globals: true,
		environment: 'node',
	},
})
