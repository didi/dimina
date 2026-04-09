import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vite'
import htmlMinifier from 'vite-plugin-html-minifier'

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
			},
		},
		css: {
			preprocessorOptions: {
				scss: {
					additionalData: `@use "@/styles/funcs" as *;`,
				},
			},
		},
		optimizeDeps: {
			include: ['vconsole'],
		},
		build: {
			modulePreload: false,
			minify: mode === 'production',
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'index.html'),
					pageFrame: resolve(__dirname, 'pageFrame.html'),
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
