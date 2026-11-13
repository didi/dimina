import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
	base: './',
	publicDir: process.env.DIMINA_DESKTOP_SDK === '1' ? false : fileURLToPath(new URL('../../fe/packages/container/public', import.meta.url)),
	plugins: process.env.DIMINA_DESKTOP_SDK === '1' ? [{ name: 'sdk-catalog', generateBundle() { this.emitFile({ type: 'asset', fileName: 'appList.json', source: '[]' }) } }] : [],
	build: {
		target: 'safari15',
		assetsInlineLimit: 0,
		rollupOptions: {
			input: {
				index: fileURLToPath(new URL('./index.html', import.meta.url)),
				pageFrame: fileURLToPath(new URL('./pageFrame.html', import.meta.url)),
			},
		},
	},
})
