import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const local = name => fileURLToPath(new URL(`./src/browser/${name}.js`, import.meta.url))
export default defineConfig({
	base: './',
	resolve: { alias: [
		{ find: 'node:fs', replacement: local('fs') },
		{ find: 'node:path', replacement: 'path-browserify' },
		{ find: /^node:(?:os|crypto|process|worker_threads|async_hooks|url|module)$/, replacement: local('platform') },
		{ find: /^oxc-parser$/, replacement: local('parser') },
		{ find: /^esbuild$/, replacement: local('transform') },
		{ find: /^@vue\/compiler-sfc$/, replacement: '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js' },
		{ find: /^cheerio$/, replacement: 'cheerio/slim' },
		{ find: /^autoprefixer$/, replacement: local('autoprefixer') },
		{ find: /^(?:cssnano|less|sass)$/, replacement: local('postcss') },
	] },
	define: { 'process.env.NODE_ENV': '"production"' },
	build: {
		target: 'es2022', emptyOutDir: false, assetsInlineLimit: 0,
		lib: { entry: local('index'), formats: ['es'], fileName: () => 'browser.js' },
		rollupOptions: { output: { assetFileNames: 'browser/[name][extname]' } },
	},
})
