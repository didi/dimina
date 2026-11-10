import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'

const root = fileURLToPath(new URL('.', import.meta.url))
const assetBuild = (entry, outDir, fileName) => build({
	configFile: false, root,
	define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'import.meta.url': '"https://dimina.invalid/runtime.js"' },
	build: {
		target: 'es2022', outDir, emptyOutDir: false, minify: true,
		lib: { entry: `${root}src/${entry}`, name: 'DiminaGeneratedRuntime', formats: ['iife'], fileName: () => `${fileName}.js`, cssFileName: fileName },
	},
})
await rm(`${root}dist`, { recursive: true, force: true })
await mkdir(`${root}.runtime`, { recursive: true })
await assetBuild('renderFrame.js', `${root}.runtime`, 'render')
await assetBuild('sandbox.js', `${root}.runtime`, 'sandbox')
await build({
	configFile: false, root,
	base: './',
	build: {
		target: 'es2022', outDir: 'dist', emptyOutDir: false, assetsInlineLimit: 0,
		lib: { entry: { index: `${root}src/index.js`, store: `${root}src/store.js` }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
	},
	worker: { format: 'es' },
})
