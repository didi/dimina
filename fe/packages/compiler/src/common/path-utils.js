import path from 'node:path'

const WINDOWS_FS_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/

function isWindowsFsPath(targetPath) {
	return typeof targetPath === 'string'
		&& (WINDOWS_FS_PATH_RE.test(targetPath) || targetPath.includes('\\'))
}

function getFsPathApi(targetPath) {
	return isWindowsFsPath(targetPath) ? path.win32 : path.posix
}

function normalizeToPosixPath(targetPath) {
	return targetPath.replace(/\\/g, '/')
}

function resolveMiniProgramPath(workPath, importerPath, sourcePath) {
	const pathApi = getFsPathApi(importerPath || workPath)
	return sourcePath.startsWith('/')
		? pathApi.join(workPath, sourcePath)
		: pathApi.resolve(pathApi.dirname(importerPath), sourcePath)
}

function toMiniProgramModuleId(resolvedPath, workPath) {
	const normalizedResolvedPath = normalizeToPosixPath(resolvedPath)
	const normalizedWorkPath = normalizeToPosixPath(workPath)

	let moduleId = normalizedResolvedPath.startsWith(normalizedWorkPath)
		? normalizedResolvedPath.slice(normalizedWorkPath.length)
		: normalizedResolvedPath

	moduleId = moduleId.replace(/\/+/g, '/')
	if (!moduleId.startsWith('/')) {
		moduleId = `/${moduleId}`
	}

	return moduleId
}

function getRelativePosixPath(targetPath, rootPath) {
	return normalizeToPosixPath(targetPath)
		.replace(normalizeToPosixPath(rootPath), '')
		.replace(/^\//, '')
}

export {
	getFsPathApi,
	getRelativePosixPath,
	isWindowsFsPath,
	normalizeToPosixPath,
	resolveMiniProgramPath,
	toMiniProgramModuleId,
}
