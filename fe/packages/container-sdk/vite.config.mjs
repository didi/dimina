import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 把 `@dimina/service?url` 落成 dist 里独立的静态文件 + 指向它的 URL 常量。
 * 不能走 Vite 默认的 `?url` 管线：对解析到项目根目录之外的资源（workspace 符号
 * 链接指向的另一个包），它固定内联成 base64 data: URL，不受 assetsInlineLimit
 * 影响——worker 脚本会膨胀进 index.js，且 `new Worker(dataURL)` 兼容性不佳。
 *
 * 实现：不用 Rollup 标准的 emitFile + `import.meta.ROLLUP_FILE_URL_<id>` 占位符
 * 机制（会引入 import.meta 依赖），改为 load() 阶段塞占位符字符串，generateBundle()
 * 阶段对产物 chunk 做文本替换，换成 `new URL(..., import.meta.url)` 表达式。
 */
function diminaServiceUrlPlugin() {
	const virtualId = '\0dimina-service-url'
	const placeholder = '__DIMINA_SERVICE_URL_PLACEHOLDER__'
	const assetFileName = 'service.js'

	return {
		name: 'dimina-service-url',
		// 必须先于 Vite 内建的 `?url` 处理拿到这个 specifier
		enforce: 'pre',
		resolveId(source) {
			if (source === '@dimina/service?url') {
				return virtualId
			}
		},
		load(id) {
			if (id === virtualId) {
				// @dimina/service 的 exports 只声明了 "import" 条件，require.resolve()
				// 读不到，须用 Node 原生 ESM 解析器。
				const realPath = fileURLToPath(import.meta.resolve('@dimina/service'))
				// 固定文件名（不带 hash）：重复构建幂等，相对路径替换也不必关心 hash
				this.emitFile({
					type: 'asset',
					fileName: assetFileName,
					source: fs.readFileSync(realPath),
				})
				return `export default ${JSON.stringify(placeholder)};`
			}
		},
		generateBundle(_options, bundle) {
			const replacement = `new URL(${JSON.stringify(`./${assetFileName}`)}, import.meta.url).href`

			// 产物里字符串字面量的引号形式不固定（可能被改写成反引号），
			// 按「包住 placeholder 的任意引号字符」通配匹配。
			const placeholderPattern = new RegExp(`(["'\`])${placeholder}\\1`, 'g')
			for (const file of Object.values(bundle)) {
				if (file.type === 'chunk' && file.code.includes(placeholder)) {
					file.code = file.code.replace(placeholderPattern, replacement)
				}
			}
		},
	}
}

// 库构建：产出纯 ESM + 提取的 CSS，宿主直接消费构建产物。两个入口互无交集，
// 必须分开产出，避免把 index 的体积和运行时副作用带进 pageFrame 的纯渲染上下文：
//   index     —— 公开的 createContainer() API，宿主主线程消费。
//   pageFrame —— 渲染层 iframe 里跑的独立入口（挂 modDefine/modRequire、
//                按需加载 vconsole、引入 @dimina/components 样式与 @dimina/render）。
export default defineConfig({
	plugins: [diminaServiceUrlPlugin()],
	css: {
		preprocessorOptions: {
			scss: {
				// miniApp.scss / webview.scss 直接用 $deviceWidth / logic()，不各自 @use，
				// 依赖这里的全局注入。
				additionalData: `@use "${fileURLToPath(new URL('./src/styles/funcs.scss', import.meta.url)).replace(/\\/g, '/')}" as *;`,
			},
		},
	},
	build: {
		outDir: 'dist',
		// watch 模式不清空 outDir：清库空窗期会让并行启动的消费方解析包失败，
		// 且 Vite 缓存失败解析、不自愈。产物文件名全固定（无 hash），增量覆盖写安全。
		emptyOutDir: !process.argv.includes('--watch'),
		cssCodeSplit: true,
		// 禁止把 `?url` 资源内联成 base64，service.js 必须是 dist 下的独立静态文件
		assetsInlineLimit: 0,
		lib: {
			entry: {
				index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
				pageFrame: fileURLToPath(new URL('./src/pages/pageFrame/pageFrame.ts', import.meta.url)),
			},
			formats: ['es'],
			fileName: (_format, entryName) => `${entryName}.js`,
		},
		rollupOptions: {
			// 只把真实发布到 registry 的三方运行时依赖标为 external（宿主装得到）；
			// vconsole 还需保持 pageFrame 里按需动态 import 的懒加载语义。
			// @dimina/* workspace 依赖内联进产物：它们不在外部 registry 上，
			// external 会把解析负担转嫁给每个宿主。内联是安全的——它们只被 pageFrame
			// 入口引用，而每个 pageFrame.html 只在自己的 iframe 里加载一份，不存在
			// 重复注册风险；这个前提只要 index 入口以后也开始用它们就会失效。
			// `@dimina/service?url` 不能 external——`?url` 后缀只有 Vite 认识，
			// 残留到产物里会让消费方解析失败，必须交给 diminaServiceUrlPlugin 处理。
			external: [
				'chalk',
				'mitt',
				'vconsole',
			],
			output: {
				preserveModules: false,
			},
		},
	},
})
