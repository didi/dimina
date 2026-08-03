import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vite'
import htmlMinifier from 'vite-plugin-html-minifier'

function isVConsoleEvalWarning(warning) {
	const message = warning?.message || ''
	const id = warning?.id || warning?.loc?.file || ''

	return warning?.code === 'EVAL' && (message.includes('vconsole') || id.includes('vconsole'))
}

export default defineConfig(({ mode }) => {
	return {
		base: process.env.GITHUB_ACTIONS ? '/dimina/' : '/',
		server: {
			open: true, // 启动后是否自动打开浏览器
		},
		define: {
			__DEV__: mode !== 'production',
		},
		resolve: {
			extensions: ['.js', '.scss'],
			alias: {
				'@': resolve(__dirname, 'src'),
				'@images': '/images',
				...(mode === 'test'
					? { '@dimina/service?url': resolve(__dirname, '__tests__/fixtures/service-worker-url.js') }
					: {}),
			},
		},
		css: {
			preprocessorOptions: {
				scss: {
					// logic() 缩放函数的唯一实现在 container-sdk（demo 与 SDK 的样式都要用它）。
					// 用绝对文件路径直接 @use，不经 Vite alias，避免 Sass 解析歧义。
					additionalData: `@use "${resolve(__dirname, '../container-sdk/src/styles/funcs.scss').replace(/\\/g, '/')}" as *;`,
				},
			},
		},
		build: {
			modulePreload: false,
			minify: mode === 'production',
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'index.html'),
					pageFrame: resolve(__dirname, 'pageFrame.html'),
				},
				onwarn(warning, warn) {
					if (isVConsoleEvalWarning(warning)) {
						return
					}
					warn(warning)
				},
				output: {
					// 设置入口文件（通常为主JavaScript文件）的命名规则
					entryFileNames: 'assets/[name].js',
					// 设置非入口 chunk（如按需加载的模块）的命名规则
					chunkFileNames: 'assets/[name].js',
					// 设置静态资源（如图片、字体等）的命名规则
					assetFileNames: 'assets/[name][extname]',
				},
			},
		},
		plugins: [
			htmlMinifier({
				minify: mode === 'production',
			}),
		],
	}
})
