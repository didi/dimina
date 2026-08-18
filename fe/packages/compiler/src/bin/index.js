#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import chokidar from 'chokidar'
import { program } from 'commander'
import pack from '../../package.json' with { type: 'json' }
import build from '../index.js'
import { createIgnoredPathMatcher, createWatchBuildPlan, createWatchRebuildScheduler, getPublishedOutputPath } from './watch.js'
import { DependencyGraph } from '../common/dependency-graph.js'

program
	.command('build')
	.option('-c, --work-path <path>', '编译工作目录')
	.option('-s, --target-path <path>', '编译产物存放路径')
	.option('-w, --watch', '启用监听文件改动')
	.option('--no-app-id-dir', '产物根目录不包含appId')
	.option('--sourcemap', '生成 sourcemap 文件用于调试')
	.action(async (options) => {
		const workPath = options.workPath ? path.resolve(options.workPath) : process.cwd()
		const targetPath = options.targetPath ? path.resolve(options.targetPath) : process.cwd()
		const useAppIdDir = options.appIdDir !== false
		const sourcemap = !!options.sourcemap

		let buildResult
		try {
			buildResult = await build(targetPath, workPath, useAppIdDir, { sourcemap })
		}
		catch (error) {
			throw new Error(`${workPath} 编译出错: ${error.message}`, { cause: error })
		}
		const watch = options.watch
		if (watch) {
			let dependencyGraph = new DependencyGraph(buildResult.dependencyGraph)
			const ignoredOutputPaths = new Set([
				getPublishedOutputPath(targetPath, useAppIdDir, buildResult.appId),
			])
			const eventLabels = {
				add: '新增',
				change: '改动',
				unlink: '删除',
			}
			const scheduler = createWatchRebuildScheduler({
				rebuild: async (change) => {
					const publishedPath = getPublishedOutputPath(targetPath, useAppIdDir, buildResult.appId)
					const plan = createWatchBuildPlan({
						...change,
						dependencyGraph,
						publishedPath,
					})
					if (plan.skip) return
					const result = await build(targetPath, workPath, useAppIdDir, {
						sourcemap,
						...plan.options,
					})
					buildResult = result
					dependencyGraph = new DependencyGraph(result.dependencyGraph)
					ignoredOutputPaths.add(getPublishedOutputPath(targetPath, useAppIdDir, result.appId))
				},
				onRebuild: ({ event, filePath, count }) => {
					const merged = count > 1 ? `（合并 ${count} 个文件事件）` : ''
					console.log(`${filePath} ${eventLabels[event]}，重新编译${merged}`)
				},
				onError: (error) => {
					console.error(`${workPath} 编译出错: ${error.message}`)
				},
			})
			chokidar
				.watch(workPath, {
					persistent: true, // 持续监听
					ignoreInitial: true, // 忽略初始的 add/addDir 事件
					ignored: createIgnoredPathMatcher(ignoredOutputPaths),
				})
				.on('all', (event, filePath) => {
					const plan = createWatchBuildPlan({
						event,
						filePath,
						dependencyGraph,
						publishedPath: getPublishedOutputPath(targetPath, useAppIdDir, buildResult.appId),
					})
					if (plan.skip) {
						return
					}
					scheduler.schedule(event, filePath)
				})
		}
	})

program
	.name('dmcc')
	.version(pack.version)

program.parseAsync(process.argv).catch((error) => {
	console.error(error.stack || error.message)
	process.exitCode = 1
})
