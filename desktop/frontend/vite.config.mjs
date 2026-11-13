import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
	base: './',
	publicDir: fileURLToPath(new URL('../../fe/packages/container/public', import.meta.url)),
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
