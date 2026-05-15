import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'custom',
	environments: {
		client: {
			consumer: 'server',
		},
		ssr: {
			consumer: 'server',
		},
	},
	build: {
		lib: {
			// Multiple entry points
			entry: {
				'index': resolve(__dirname, 'src/index.js'),
				'core/view-compiler': resolve(__dirname, 'src/core/view-compiler.js'),
				'core/logic-compiler': resolve(__dirname, 'src/core/logic-compiler.js'),
				'core/style-compiler': resolve(__dirname, 'src/core/style-compiler.js'),
				'bin/index': resolve(__dirname, 'src/bin/index.js'),
			},
			formats: ['es', 'cjs'],
			fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
		},
		rollupOptions: {
			external: [
				'node:os',
				'node:fs',
				'node:path',
				'node:url',
				'node:process',
				'node:worker_threads',
				'node:buffer',
				'@vue/compiler-sfc',
				'autoprefixer',
				'cheerio',
				'chokidar',
				'commander',
				'cssnano',
				'esbuild',
				'htmlparser2',
				'listr2',
				'postcss',
				'postcss-selector-parser',
				'less',
				'sass',
				'shelljs',
				'oxc-parser',
				'oxc-walker',
				'magic-string',
			],
		},
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
		target: 'node18',
		minify: false,
	},
})
