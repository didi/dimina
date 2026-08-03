import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			// @dimina/service 逻辑线程包目前只以构建产物形式存在；测试环境用一个空的
			// data: URL 占位，避免解析真实 workspace 依赖（同 fe/packages/container/vite.config.mjs 的先例）。
			'@dimina/service?url': fileURLToPath(new URL('./__tests__/fixtures/service-worker-url.js', import.meta.url)),
		},
	},
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: [fileURLToPath(new URL('./__tests__/setup.js', import.meta.url))],
	},
})
