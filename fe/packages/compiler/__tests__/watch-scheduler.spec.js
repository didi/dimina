import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DependencyGraph } from '../src/common/dependency-graph.js'
import { createIgnoredPathMatcher, createWatchBuildPlan, createWatchRebuildScheduler, getPublishedOutputPath } from '../src/bin/watch.js'

describe('compiler watch scheduler', () => {
	it('rebuilds for added, changed, and deleted files but ignores directory events', async () => {
		const rebuild = vi.fn().mockResolvedValue(undefined)
		const scheduler = createWatchRebuildScheduler({ rebuild })

		expect(scheduler.schedule('addDir', '/project/components')).toBe(false)
		expect(scheduler.schedule('unlinkDir', '/project/components')).toBe(false)
		for (const event of ['add', 'change', 'unlink']) {
			expect(scheduler.schedule(event, `/project/index.${event}`)).toBe(true)
			await scheduler.waitForIdle()
		}

		expect(rebuild).toHaveBeenCalledTimes(3)
	})

	it('serializes builds and coalesces events received while a build is running', async () => {
		let finishFirstBuild
		const firstBuild = new Promise((resolve) => {
			finishFirstBuild = resolve
		})
		const rebuild = vi.fn()
			.mockImplementationOnce(() => firstBuild)
			.mockResolvedValue(undefined)
		const onRebuild = vi.fn()
		const scheduler = createWatchRebuildScheduler({ rebuild, onRebuild })

		scheduler.schedule('change', '/project/app.json')
		scheduler.schedule('add', '/project/pages/new/index.js')
		scheduler.schedule('unlink', '/project/pages/old/index.js')
		expect(rebuild).toHaveBeenCalledTimes(1)

		finishFirstBuild()
		await scheduler.waitForIdle()

		expect(rebuild).toHaveBeenCalledTimes(2)
		expect(onRebuild).toHaveBeenNthCalledWith(1, {
			event: 'change',
			filePath: '/project/app.json',
			count: 1,
		})
		expect(onRebuild).toHaveBeenNthCalledWith(2, {
			event: 'unlink',
			filePath: '/project/pages/old/index.js',
			count: 2,
		})
	})

	it('keeps accepting rebuilds after a failed compilation', async () => {
		const error = new Error('invalid template')
		const rebuild = vi.fn()
			.mockRejectedValueOnce(error)
			.mockResolvedValue(undefined)
		const onError = vi.fn()
		const scheduler = createWatchRebuildScheduler({ rebuild, onError })

		scheduler.schedule('change', '/project/pages/index/index.wxml')
		await scheduler.waitForIdle()
		scheduler.schedule('change', '/project/pages/index/index.wxml')
		await scheduler.waitForIdle()

		expect(rebuild).toHaveBeenCalledTimes(2)
		expect(onError).toHaveBeenCalledWith(error, expect.objectContaining({
			filePath: '/project/pages/index/index.wxml',
		}))
	})

	it('ignores the published app directory without hiding similarly prefixed source paths', () => {
		const workPath = path.resolve('/project')
		const outputPath = getPublishedOutputPath(workPath, true, 'test-app')
		const ignoredPaths = new Set([outputPath])
		const isIgnored = createIgnoredPathMatcher(ignoredPaths)

		expect(isIgnored(outputPath)).toBe(true)
		expect(isIgnored(path.join(outputPath, 'main/logic.js'))).toBe(true)
		expect(isIgnored(path.join(workPath, 'test-app-source/index.js'))).toBe(false)
		expect(isIgnored(path.join(workPath, 'pages/index/index.js'))).toBe(false)
	})

	it('uses reverse dependencies for incremental changes and keeps structural changes full', () => {
		const graph = new DependencyGraph()
		graph.addNode('pages/index/index', { entry: true, type: 'page' })
		graph.addNode('/components/card/index', { type: 'component' })
		graph.addDependency('pages/index/index', '/components/card/index', 'component')
		graph.addFile('/components/card/index', '/project/components/card/index.wxml', 'view')
		graph.addFile('pages/index/index', '/project/pages/index/index.json', 'config')

		const incremental = createWatchBuildPlan({
			event: 'change',
			filePath: '/project/components/card/index.wxml',
			dependencyGraph: graph,
			publishedPath: '/dist/app',
		})
		expect(incremental).toMatchObject({
			skip: false,
			incremental: true,
			options: {
				affectedEntries: ['pages/index/index'],
				stages: ['view'],
				seedPath: '/dist/app',
			},
		})

		expect(createWatchBuildPlan({
			event: 'change',
			filePath: '/project/pages/index/index.json',
			dependencyGraph: graph,
			publishedPath: '/dist/app',
		})).toEqual({ skip: false, incremental: false, options: {} })
		expect(createWatchBuildPlan({
			event: 'change',
			filePath: '/project/README.md',
			dependencyGraph: graph,
			publishedPath: '/dist/app',
		})).toEqual({ skip: true, incremental: false, options: {} })
		expect(createWatchBuildPlan({
			event: 'change',
			filePath: '/project/components/card/index.wxml',
			count: 2,
			dependencyGraph: graph,
			publishedPath: '/dist/app',
		})).toEqual({ skip: false, incremental: false, options: {} })
	})
})
