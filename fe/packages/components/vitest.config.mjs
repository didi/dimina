import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import ViteAutoImport from 'unplugin-auto-import/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		vue(),
		ViteAutoImport({
			imports: [
				'vue',
				{ vue: ['cloneVNode'] },
			],
			dts: false,
		}),
	],
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
