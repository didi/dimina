import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
	return {
		resolve: {
			extensions: ['.js'],
			alias: {
				'@': resolve(__dirname, 'src'),
			},
		},
		build: {
			minify: mode === 'production',
			lib: {
				entry: resolve(__dirname, 'src/index.js'),
				formats: ['es'],
				fileName: 'common',
			},
		},
	}
})
