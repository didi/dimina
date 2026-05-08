import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Listr } from 'listr2'
import { createDist, publishToDist } from './common/publish.js'
import { artCode } from './common/utils.js'
import { workerPool } from './common/worker-pool.js'
import { NpmBuilder } from './common/npm-builder.js'
import { compileConfig } from './core/index.js'
import { getAppConfigInfo, getAppId, getAppName, getPages, getTargetPath, getWorkPath, storeInfo } from './env.js'

let isPrinted = false

/**
 * 构建命令入口
 * @param {string} targetPath 编译产物目标路径
 * @param {string} workPath 编译工作目录
 * @param {boolean} useAppIdDir 产物根目录是否包含appId
 */
export default async function build(targetPath, workPath, useAppIdDir = true, options = {}) {
	const { sourcemap = false } = options
	if (!isPrinted) {
		artCode()
		isPrinted = true
	}
	const tasks = new Listr(
		[
			{
				title: '准备项目编译环境',
				task: (_, task) =>
					task.newListr(
						[
							{
								title: '收集配置信息',
								task: (ctx) => {
									ctx.storeInfo = storeInfo(workPath)
								},
							},
							{
								title: '准备产物目录',
								task: () => {
									createDist()
								},
							},
							{
								title: '编译配置信息',
								task: () => {
									compileConfig()
								},
							},
							{
								title: '构建 npm 包',
								task: async () => {
									const npmBuilder = new NpmBuilder(getWorkPath(), getTargetPath())
									await npmBuilder.buildNpmPackages()
								},
							},
						],
						{ concurrent: false },
					),
			},
			{
				title: `开始编译:${workPath.split('/').pop()}`,
				task: (ctx, task) => {
					const pages = getPages()
					ctx.pages = pages

					return task.newListr(
						[
							{
								title: '编译页面文件',
								task: async (ctx, task) => {
									// ddml, wxml
									return runCompileInWorker('view', ctx, task, { sourcemap })
								},
							},
							{
								title: '编译页面逻辑',
								task: async (ctx, task) => {
									return runCompileInWorker('logic', ctx, task, { sourcemap })
								},
							},
							{
								title: '编译样式文件',
								task: async (ctx, task) => {
									// ddss, wxss
									// 主包添加 app 样式
									pages.mainPages.unshift({
										path: 'app',
										id: '',
									})
									return runCompileInWorker('style', ctx, task, { sourcemap })
								},
							},
						],
						{ concurrent: true },
					)
				},
			},
			{
				title: '输出编译产物',
				task: () => {
					publishToDist(targetPath, useAppIdDir)
				},
			},
		],
		{ concurrent: false },
	)

	try {
		const context = await tasks.run()
		return {
			appId: getAppId(),
			name: getAppName(),
			path: getAppConfigInfo().entryPagePath || context.pages.mainPages[1].path,
		}
	}
	catch (e) {
		console.error(`${workPath} 编译出错: ${e.message}\n${e.stack}`)
	}
}

function runCompileInWorker(script, ctx, task, options = {}) {
	return workerPool.runWorker(() => new Promise((resolve, reject) => {
		const worker = new Worker(
			path.join(path.dirname(fileURLToPath(import.meta.url)), `core/${script}-compiler.js`),
			workerPool.getWorkerOptions(),
		)
		const totalTasks = Object.keys(ctx.pages.mainPages).length
			+ Object.values(ctx.pages.subPages).reduce((sum, item) => sum + item.info.length, 0)

		let isResolved = false
		let workerError = null

		// 统一的错误处理函数，防止重复 reject
		const handleError = (error) => {
			if (isResolved) return
			isResolved = true
			worker.terminate()
			reject(error)
		}

		worker.postMessage({ pages: ctx.pages, storeInfo: ctx.storeInfo, sourcemap: !!options.sourcemap })
		// 接收 Worker 完成后的消息
		worker.on('message', (message) => {
			try {
				if (message.completedTasks) {
					const progress = message.completedTasks / totalTasks
					const percentage = progress * 100
					const barLength = 30
					const filledLength = Math.ceil(barLength * progress)
					const bar = '\u2588'.repeat(filledLength) + '\u2591'.repeat(barLength - filledLength)
					task.output = `[${bar}] ${percentage.toFixed(2)}%`
				}

				if (message.success) {
					if (isResolved) return
					isResolved = true
					worker.terminate()
					resolve()
				}
				else if (message.error) {
					const error = new Error(message.error.message || message.error)
					if (message.error.stack)
						error.stack = message.error.stack
					if (message.error.file)
						error.file = message.error.file
					if (message.error.line)
						error.line = message.error.line
					handleError(error)
				}
			}
			catch (err) {
				handleError(new Error(`Error processing worker message: ${err.message}\n${err.stack}`))
			}
		})

		worker.on('error', (err) => {
			// 保存错误信息，可能在 exit 事件中使用
			workerError = err
			handleError(err)
		})
		worker.on('exit', (code) => {
			if (code !== 0 && !isResolved) {
				// 如果已经有 workerError，使用它；否则创建新的错误
				// 退出码 1 通常表示内存溢出或其他致命错误
				const error = workerError || new Error(
					code === 1
						? 'Worker terminated due to reaching memory limit: JS heap out of memory'
						: `Worker stopped with exit code ${code}`
				)
				handleError(error)
			}
		})
	}))
}
