import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { getCompileStagesForFiles } from './compile-stages.js'
import { DependencyGraph } from './dependency-graph.js'

const COMPILE_CACHE_VERSION = 2

function getProjectFileManifest(workPath) {
	const files = []
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const filePath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				visit(filePath)
			}
			else if (entry.isFile()) {
				files.push(path.relative(workPath, filePath).split(path.sep).join('/'))
			}
		}
	}
	visit(workPath)
	return files.sort()
}

function getRawDependencyFiles(dependencyGraph) {
	return [...new Set(
		(dependencyGraph?.nodes || []).flatMap(node => node.files || []),
	)].sort()
}

function resolveDependencyFilePath(filePath, workPath) {
	return path.isAbsolute(filePath) ? filePath : path.resolve(workPath, filePath)
}

function getDependencyFiles(dependencyGraph, workPath = process.cwd()) {
	return getRawDependencyFiles(dependencyGraph)
		.map(filePath => resolveDependencyFilePath(filePath, workPath))
}

function toCachePath(workPath, filePath) {
	return path.relative(workPath, path.resolve(filePath)).split(path.sep).join('/')
}

function serializeDependencyGraphForCache(dependencyGraph, workPath) {
	return {
		...dependencyGraph,
		pathFormat: 'relative',
		nodes: (dependencyGraph?.nodes || []).map(node => ({
			...node,
			files: (node.files || []).map(filePath => toCachePath(workPath, filePath)),
		})),
		fileEdges: (dependencyGraph?.fileEdges || []).map(fileEdge => ({
			...fileEdge,
			file: toCachePath(workPath, fileEdge.file),
		})),
	}
}

function hydrateDependencyGraphFromCache(dependencyGraph, workPath) {
	if (dependencyGraph?.pathFormat !== 'relative') {
		return dependencyGraph
	}
	const snapshot = { ...dependencyGraph }
	delete snapshot.pathFormat
	return {
		...snapshot,
		nodes: (snapshot.nodes || []).map(node => ({
			...node,
			files: (node.files || []).map(filePath => path.resolve(workPath, filePath)),
		})),
		fileEdges: (snapshot.fileEdges || []).map(fileEdge => ({
			...fileEdge,
			file: path.resolve(workPath, fileEdge.file),
		})),
	}
}

function fingerprintFile(filePath, previousFingerprint) {
	let stat
	try {
		stat = fs.statSync(filePath)
	}
	catch {
		return { missing: true }
	}
	if (!stat.isFile()) {
		return { missing: true }
	}
	if (previousFingerprint
		&& !previousFingerprint.missing
		&& previousFingerprint.mtimeMs === stat.mtimeMs
		&& previousFingerprint.ctimeMs === stat.ctimeMs
		&& previousFingerprint.size === stat.size
		&& previousFingerprint.hash) {
		return previousFingerprint
	}
	return {
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		hash: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
	}
}

function createDependencyFileFingerprints(dependencyGraph, previousFingerprints = {}, workPath = process.cwd()) {
	return Object.fromEntries(
		getRawDependencyFiles(dependencyGraph).map(cachePath => [
			cachePath,
			fingerprintFile(
				resolveDependencyFilePath(cachePath, workPath),
				previousFingerprints[cachePath],
			),
		]),
	)
}

function inspectDependencyFileChanges(dependencyGraph, previousFingerprints, workPath = process.cwd()) {
	const currentFingerprints = createDependencyFileFingerprints(dependencyGraph, previousFingerprints, workPath)
	const changedFiles = []
	const invalidFiles = []
	for (const cachePath of getRawDependencyFiles(dependencyGraph)) {
		const filePath = resolveDependencyFilePath(cachePath, workPath)
		const previous = previousFingerprints?.[cachePath]
		const current = currentFingerprints[cachePath]
		if (!previous || (!previous.missing && !previous.hash)) {
			invalidFiles.push(filePath)
			continue
		}
		if (previous.missing !== current.missing) {
			changedFiles.push({
				filePath,
				event: current.missing ? 'unlink' : 'add',
			})
		}
		else if (!current.missing && previous.hash !== current.hash) {
			changedFiles.push({ filePath, event: 'change' })
		}
	}
	return { changedFiles, currentFingerprints, invalidFiles }
}

function createFullBuildPlan(reason) {
	return { mode: 'full', reason, options: {} }
}

function createCachedAppBuildPlan({ cacheEntry, workPath, publishedPath }) {
	if (!cacheEntry?.appInfo || !cacheEntry.dependencyGraph || !cacheEntry.fileFingerprints) {
		return createFullBuildPlan('missing-cache-data')
	}
	if (!fs.existsSync(publishedPath)) {
		return createFullBuildPlan('missing-output')
	}
	if (!Array.isArray(cacheEntry.dependencyGraph.fileEdges)) {
		return createFullBuildPlan('untyped-dependency-graph')
	}
	if (!Array.isArray(cacheEntry.projectFiles)) {
		return createFullBuildPlan('missing-project-manifest')
	}
	const projectFiles = getProjectFileManifest(workPath)
	if (projectFiles.length !== cacheEntry.projectFiles.length
		|| projectFiles.some((filePath, index) => filePath !== cacheEntry.projectFiles[index])) {
		return createFullBuildPlan('file-structure-changed')
	}

	const inspection = inspectDependencyFileChanges(
		cacheEntry.dependencyGraph,
		cacheEntry.fileFingerprints,
		workPath,
	)
	if (inspection.invalidFiles.length > 0) {
		return createFullBuildPlan('invalid-file-fingerprints')
	}
	if (inspection.changedFiles.length === 0) {
		return {
			mode: 'skip',
			reason: 'unchanged',
			fileFingerprints: inspection.currentFingerprints,
		}
	}
	if (inspection.changedFiles.some(change => change.event !== 'change')) {
		return createFullBuildPlan('file-structure-changed')
	}
	if (inspection.changedFiles.some(change => path.extname(change.filePath).toLowerCase() === '.json')) {
		return createFullBuildPlan('config-changed')
	}

	const hydratedDependencyGraph = hydrateDependencyGraphFromCache(cacheEntry.dependencyGraph, workPath)
	const dependencyGraph = new DependencyGraph(hydratedDependencyGraph)
	const changedFilePaths = inspection.changedFiles.map(change => change.filePath)
	const { stages, unknownKinds } = getCompileStagesForFiles(dependencyGraph, changedFilePaths)
	if (unknownKinds.length > 0 || changedFilePaths.some(filePath => dependencyGraph.getFileKinds(filePath).length === 0)) {
		return createFullBuildPlan('unknown-dependency-kind')
	}
	const affectedEntries = [...new Set(
		changedFilePaths.flatMap(filePath => dependencyGraph.getAffectedEntries(filePath)),
	)].sort()
	if (affectedEntries.length === 0) {
		return {
			mode: 'skip',
			reason: 'no-affected-entry',
			fileFingerprints: inspection.currentFingerprints,
		}
	}

	return {
		mode: 'incremental',
		reason: 'dependency-change',
		changedFiles: changedFilePaths,
		fileFingerprints: inspection.currentFingerprints,
		options: {
			affectedEntries,
			stages,
			seedPath: publishedPath,
			dependencyGraph: hydratedDependencyGraph,
		},
	}
}

function createAppCacheEntry(buildResult, workPath, previousFingerprints = {}) {
	const { dependencyGraph, ...appInfo } = buildResult
	const cachedDependencyGraph = serializeDependencyGraphForCache(dependencyGraph, workPath)
	return {
		lastCompileTime: Date.now(),
		appInfo,
		dependencyGraph: cachedDependencyGraph,
		projectFiles: getProjectFileManifest(workPath),
		fileFingerprints: createDependencyFileFingerprints(
			cachedDependencyGraph,
			previousFingerprints,
			workPath,
		),
	}
}

export {
	COMPILE_CACHE_VERSION,
	createAppCacheEntry,
	createCachedAppBuildPlan,
	createDependencyFileFingerprints,
	getDependencyFiles,
	getProjectFileManifest,
	hydrateDependencyGraphFromCache,
	inspectDependencyFileChanges,
	serializeDependencyGraphForCache,
}
