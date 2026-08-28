export const VIRTUAL_FILE_PREFIX = (globalThis as any).__VIRTUAL_FILE_PREFIX__ || 'difile://'
export const VIRTUAL_USER_PREFIX = VIRTUAL_FILE_PREFIX + 'usr/'
const STORAGE_ROOT = 'dimina-file-system'

interface StorageManagerWithDirectory {
	getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

export interface SaveWebFileOptions {
	appId: string
	tempFilePath: string
	filePath?: string
	resourceBaseUrl: string
}

function safePathSegment(segment: string): string {
	let decoded: string
	try {
		decoded = decodeURIComponent(segment)
	}
	catch {
		throw new Error(`invalid file path segment: ${segment}`)
	}
	if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) {
		throw new Error(`invalid file path segment: ${segment}`)
	}
	return decoded
}

function userPathSegments(filePath: string): string[] {
	if (!filePath.startsWith(VIRTUAL_USER_PREFIX)) {
		throw new Error('filePath must be under wx.env.USER_DATA_PATH')
	}
	const relativePath = filePath.slice(VIRTUAL_USER_PREFIX.length)
	const segments = relativePath.split('/').map(safePathSegment)
	if (segments.length === 0) {
		throw new Error('filePath must point to a file')
	}
	return segments
}

function fileNameFromPath(tempFilePath: string, resourceBaseUrl: string): string {
	if (tempFilePath.startsWith('data:')) {
		return 'file'
	}
	try {
		const absoluteBaseUrl = new URL(resourceBaseUrl, window.location.origin)
		const url = new URL(tempFilePath, absoluteBaseUrl)
		const name = decodeURIComponent(url.pathname.split('/').pop() || '')
		const sanitized = name.replace(/[\\/\0]/g, '_')
		return sanitized || 'file'
	}
	catch {
		return 'file'
	}
}

function defaultSavedFilePath(tempFilePath: string, resourceBaseUrl: string): string {
	const fileName = fileNameFromPath(tempFilePath, resourceBaseUrl)
	const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
	return `${VIRTUAL_USER_PREFIX}saved/${randomPart}_${fileName}`
}

async function appUserDirectory(appId: string): Promise<FileSystemDirectoryHandle> {
	const storage = navigator.storage as StorageManagerWithDirectory
	if (typeof storage?.getDirectory !== 'function') {
		throw new TypeError('origin private file system is not supported')
	}
	let directory = await storage.getDirectory()
	directory = await directory.getDirectoryHandle(STORAGE_ROOT, { create: true })
	directory = await directory.getDirectoryHandle(encodeURIComponent(appId), { create: true })
	return directory.getDirectoryHandle('usr', { create: true })
}

async function sourceBlob(tempFilePath: string, resourceBaseUrl: string): Promise<Blob> {
	if (!tempFilePath) {
		throw new Error('tempFilePath is required')
	}
	if (tempFilePath.startsWith(VIRTUAL_FILE_PREFIX)) {
		throw new Error(`temporary virtual file is not available on Web: ${tempFilePath}`)
	}

	const absoluteBaseUrl = new URL(resourceBaseUrl, window.location.origin)
	const sourceUrl = new URL(tempFilePath, absoluteBaseUrl).toString()
	const response = await fetch(sourceUrl)
	if (!response.ok) {
		throw new Error(`failed to read tempFilePath: HTTP ${response.status}`)
	}
	return response.blob()
}

/**
 * Persist a Web temporary resource in the browser origin-private file system.
 * The returned virtual path matches the native Dimina FileSystemManager contract.
 */
export async function saveWebFile(options: SaveWebFileOptions): Promise<string> {
	const { appId, tempFilePath, resourceBaseUrl } = options
	if (!appId) {
		throw new Error('appId is required')
	}
	if (!tempFilePath) {
		throw new Error('tempFilePath is required')
	}
	const savedFilePath = options.filePath || defaultSavedFilePath(tempFilePath, resourceBaseUrl)
	const pathSegments = userPathSegments(savedFilePath)
	let directory = await appUserDirectory(appId)
	const blob = await sourceBlob(tempFilePath, resourceBaseUrl)

	for (const segment of pathSegments.slice(0, -1)) {
		directory = await directory.getDirectoryHandle(segment, { create: true })
	}
	const fileHandle = await directory.getFileHandle(pathSegments[pathSegments.length - 1], { create: true })
	const writable = await fileHandle.createWritable()
	try {
		await writable.write(blob)
		await writable.close()
	}
	catch (error) {
		await writable.abort().catch(() => {})
		throw error
	}

	return savedFilePath
}

/** Read a saved user file from this mini program's OPFS namespace. */
export async function readWebFile(appId: string, filePath: string): Promise<File> {
	if (!appId) {
		throw new Error('appId is required')
	}
	const pathSegments = userPathSegments(filePath)
	let directory = await appUserDirectory(appId)
	for (const segment of pathSegments.slice(0, -1)) {
		directory = await directory.getDirectoryHandle(segment)
	}
	const handle = await directory.getFileHandle(pathSegments[pathSegments.length - 1])
	return handle.getFile()
}
