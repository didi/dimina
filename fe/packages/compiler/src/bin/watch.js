import path from 'node:path'
import { getCompileStagesForFiles } from '../common/compile-stages.js'

const WATCH_FILE_EVENTS = new Set(['add', 'change', 'unlink'])

function createWatchRebuildScheduler({ rebuild, onRebuild = () => {}, onError = () => {} }) {
	let pendingChange
	let running = false
	let idlePromise = Promise.resolve()
	let resolveIdle

	const drain = async () => {
		while (pendingChange) {
			const change = pendingChange
			pendingChange = undefined
			try {
				onRebuild(change)
				await rebuild(change)
			}
			catch (error) {
				onError(error, change)
			}
		}

		running = false
		resolveIdle?.()
		resolveIdle = undefined
	}

	return {
		schedule(event, filePath) {
			if (!WATCH_FILE_EVENTS.has(event)) {
				return false
			}

			pendingChange = {
				event,
				filePath,
				count: (pendingChange?.count || 0) + 1,
			}
			if (!running) {
				running = true
				idlePromise = new Promise((resolve) => {
					resolveIdle = resolve
				})
				void drain()
			}
			return true
		},
		waitForIdle() {
			return idlePromise
		},
	}
}

function getPublishedOutputPath(targetPath, useAppIdDir, appId) {
	return path.resolve(targetPath, useAppIdDir ? appId : '.')
}

function createWatchBuildPlan({ event, filePath, count = 1, dependencyGraph, publishedPath }) {
	// 调度器会把构建期间到达的多个事件合并成最后一个事件。此时无法安全
	// 推导所有受影响入口，保守退回全量构建，避免漏掉前面的文件改动。
	if (count > 1 || event !== 'change' || path.extname(filePath).toLowerCase() === '.json') {
		return { skip: false, incremental: false, options: {} }
	}
	if (!dependencyGraph.hasFile(filePath)) {
		return { skip: true, incremental: false, options: {} }
	}
	const affectedEntries = dependencyGraph.getAffectedEntries(filePath)
	if (affectedEntries.length === 0) {
		return { skip: true, incremental: false, options: {} }
	}
	const { stages, unknownKinds } = getCompileStagesForFiles(dependencyGraph, [filePath])
	if (unknownKinds.length > 0) {
		return { skip: false, incremental: false, options: {} }
	}
	return {
		skip: false,
		incremental: true,
		options: {
			affectedEntries,
			stages,
			seedPath: publishedPath,
			dependencyGraph: dependencyGraph.toJSON(),
		},
	}
}

function isSameOrDescendantPath(candidatePath, directoryPath) {
	const relativePath = path.relative(directoryPath, candidatePath)
	return relativePath === ''
		|| (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function createIgnoredPathMatcher(ignoredPaths) {
	return (watchedPath) => {
		const absolutePath = path.resolve(watchedPath)
		for (const ignoredPath of ignoredPaths) {
			if (isSameOrDescendantPath(absolutePath, ignoredPath)) {
				return true
			}
		}
		return false
	}
}

export {
	createWatchBuildPlan,
	createIgnoredPathMatcher,
	createWatchRebuildScheduler,
	getPublishedOutputPath,
}
