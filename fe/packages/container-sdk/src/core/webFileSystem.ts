import { DEFAULT_VIRTUAL_FILE_PREFIX } from '../config.js'
import { decompress } from 'brotli-compress/js'

// Kept as default aliases for internal callers that do not supply a container.
// Container runtime paths always use the instance-scoped value instead.
export const VIRTUAL_FILE_PREFIX = DEFAULT_VIRTUAL_FILE_PREFIX
export const VIRTUAL_USER_PREFIX = `${VIRTUAL_FILE_PREFIX}usr/`
const STORAGE_ROOT = 'dimina-file-system'

interface StorageManagerWithDirectory {
	getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

export interface SaveWebFileOptions {
	appId: string
	tempFilePath: string
	filePath?: string
	resourceBaseUrl: string
	virtualFilePrefix?: string
}

export interface ReadWebFileOptions {
	appId: string
	filePath: string
	resourceBaseUrl: string
	virtualFilePrefix?: string
	subpackageRoots?: readonly string[]
	temporaryUrls?: ReadonlySet<string>
	encoding?: string
	position?: number
	length?: number
}

function safePathSegment(segment: string): string {
	let decoded: string
	try {
		decoded = decodeURIComponent(segment)
	}
	catch {
		throw new Error(`invalid file path segment: ${segment}`)
	}
	if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('\0') || /[\\/]/.test(decoded)) {
		throw new Error(`invalid file path segment: ${segment}`)
	}
	return decoded
}

function userPathSegments(filePath: string, virtualFilePrefix: string): string[] {
	const virtualUserPrefix = `${virtualFilePrefix}usr/`
	if (!filePath.startsWith(virtualUserPrefix)) {
		throw new Error('filePath must be under wx.env.USER_DATA_PATH')
	}
	const relativePath = filePath.slice(virtualUserPrefix.length)
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
		const sanitized = name.replace(/[\\/]/g, '_').replaceAll('\0', '_')
		return sanitized || 'file'
	}
	catch {
		return 'file'
	}
}

function defaultSavedFilePath(tempFilePath: string, resourceBaseUrl: string, virtualFilePrefix: string): string {
	const fileName = fileNameFromPath(tempFilePath, resourceBaseUrl)
	const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
	return `${virtualFilePrefix}usr/saved/${randomPart}_${fileName}`
}

async function appFileDirectory(appId: string, area: 'usr' | 'tmp', create: boolean): Promise<FileSystemDirectoryHandle> {
	const storage = navigator.storage as StorageManagerWithDirectory
	if (typeof storage?.getDirectory !== 'function') {
		throw new TypeError('origin private file system is not supported')
	}
	let directory = await storage.getDirectory()
	directory = await directory.getDirectoryHandle(STORAGE_ROOT, { create })
	directory = await directory.getDirectoryHandle(encodeURIComponent(appId), { create })
	return directory.getDirectoryHandle(area, { create })
}

async function appUserDirectory(appId: string): Promise<FileSystemDirectoryHandle> {
	return appFileDirectory(appId, 'usr', true)
}

async function sourceBlob(tempFilePath: string, resourceBaseUrl: string, virtualFilePrefix: string): Promise<Blob> {
	if (!tempFilePath) {
		throw new Error('tempFilePath is required')
	}
	if (tempFilePath.startsWith(virtualFilePrefix)) {
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
	const virtualFilePrefix = options.virtualFilePrefix ?? DEFAULT_VIRTUAL_FILE_PREFIX
	if (!appId) {
		throw new Error('appId is required')
	}
	if (!tempFilePath) {
		throw new Error('tempFilePath is required')
	}
	const savedFilePath = options.filePath || defaultSavedFilePath(tempFilePath, resourceBaseUrl, virtualFilePrefix)
	const pathSegments = userPathSegments(savedFilePath, virtualFilePrefix)
	let directory = await appUserDirectory(appId)
	const blob = await sourceBlob(tempFilePath, resourceBaseUrl, virtualFilePrefix)

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
export async function readWebFile(appId: string, filePath: string, virtualFilePrefix = DEFAULT_VIRTUAL_FILE_PREFIX): Promise<File> {
	if (!appId) {
		throw new Error('appId is required')
	}
	const pathSegments = userPathSegments(filePath, virtualFilePrefix)
	let directory = await appUserDirectory(appId)
	for (const segment of pathSegments.slice(0, -1)) {
		directory = await directory.getDirectoryHandle(segment)
	}
	const handle = await directory.getFileHandle(pathSegments[pathSegments.length - 1])
	return handle.getFile()
}

function packagePathSegments(filePath: string): string[] {
	if (/^[a-z][a-z\d+.-]*:/i.test(filePath) || filePath.startsWith('//')) {
		throw new Error('filePath must be a local package or sandbox file path')
	}
	return filePath.replace(/^\//, '').replace(/^\.\//, '').split('/').map(safePathSegment)
}

function packageFileUrl(options: ReadWebFileOptions): string {
	const { appId, filePath, resourceBaseUrl, subpackageRoots = [] } = options
	if (appId === '.' || appId === '..' || /[\\/\0]/.test(appId)) {
		throw new Error('invalid appId')
	}
	const path = packagePathSegments(filePath)
	const roots = subpackageRoots.map(root => packagePathSegments(root.replace(/\/+$/, '')).join('/'))
	const relativePath = path.join('/')
	const inSubpackage = roots.some(root => relativePath.startsWith(`${root}/`))
	const compiledPath = inSubpackage ? path : ['main', ...path]
	const baseUrl = new URL(resourceBaseUrl, window.location.origin)
	return new URL([appId, ...compiledPath].map(encodeURIComponent).join('/'), baseUrl).toString()
}

interface WebFileResource {
	data: ArrayBuffer
	contentEncoding?: string | null
}

/** Read only this app's package, OPFS namespace, or temporary object URLs. */
async function readWebFileResource(options: ReadWebFileOptions): Promise<WebFileResource> {
	const { appId, filePath, resourceBaseUrl } = options
	if (!appId) throw new Error('appId is required')
	if (typeof filePath !== 'string' || !filePath) throw new Error('filePath is required')
	const virtualFilePrefix = options.virtualFilePrefix ?? DEFAULT_VIRTUAL_FILE_PREFIX
	if (filePath.startsWith(virtualFilePrefix)) {
		const relativePath = filePath.slice(virtualFilePrefix.length)
		const [area, ...path] = relativePath.split('/')
		if (area !== 'usr' && area !== 'tmp') throw new Error('invalid sandbox file path')
		const segments = path.map(safePathSegment)
		if (!segments.length) throw new Error('filePath must point to a file')
		let directory = await appFileDirectory(appId, area, false)
		for (const segment of segments.slice(0, -1)) {
			directory = await directory.getDirectoryHandle(segment)
		}
		const handle = await directory.getFileHandle(segments[segments.length - 1])
		return { data: await (await handle.getFile()).arrayBuffer() }
	}
	let sourceUrl: string
	if (filePath.startsWith('blob:')) {
		if (!options.temporaryUrls?.has(filePath)) throw new Error('temporary file does not belong to this mini program')
		sourceUrl = filePath
	}
	else {
		sourceUrl = packageFileUrl({ ...options, resourceBaseUrl })
	}
	const response = await fetch(sourceUrl, { credentials: 'same-origin', redirect: 'error' })
	if (!response.ok) throw new Error(`failed to read filePath: HTTP ${response.status}`)
	return { data: await response.arrayBuffer(), contentEncoding: response.headers?.get('content-encoding') }
}

export async function readWebFileBytes(options: ReadWebFileOptions): Promise<ArrayBuffer> {
	return (await readWebFileResource(options)).data
}

const FILE_ENCODINGS = new Set(['ascii', 'base64', 'binary', 'hex', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'utf8', 'utf-8', 'latin1'])

function byteString(bytes: Uint8Array, mask = 255): string {
	let result = ''
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		result += String.fromCharCode(...bytes.subarray(offset, offset + 8192).map(byte => byte & mask))
	}
	return result
}

function decodeFileBytes(buffer: ArrayBuffer, encoding: string): string {
	const bytes = new Uint8Array(buffer)
	if (encoding === 'hex') return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
	if (encoding === 'base64') return btoa(byteString(bytes))
	if (encoding === 'ascii') return byteString(bytes, 127)
	if (encoding === 'binary' || encoding === 'latin1') return byteString(bytes)
	if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
	// UTF-16LE/UCS-2 preserve individual code units and ignore an incomplete trailing byte.
	const codeUnits = new Uint16Array(Math.floor(bytes.length / 2))
	for (let i = 0; i < codeUnits.length; i++) codeUnits[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8)
	let text = ''
	for (let offset = 0; offset < codeUnits.length; offset += 8192) {
		text += String.fromCharCode(...codeUnits.subarray(offset, offset + 8192))
	}
	return text
}

export async function readWebFileData(options: ReadWebFileOptions): Promise<ArrayBuffer | string> {
	const { encoding, position, length } = options
	if (encoding !== undefined && !FILE_ENCODINGS.has(encoding)) throw new Error(`invalid encoding: ${encoding}`)
	if (position !== undefined && (!Number.isSafeInteger(position) || position < 0)) throw new Error('invalid position')
	if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) throw new Error('invalid length')
	const bytes = await readWebFileBytes(options)
	if (position !== undefined && position >= bytes.byteLength) throw new Error('position exceeds file length')
	if (length !== undefined && length > bytes.byteLength) throw new Error('length exceeds file length')
	const start = position ?? 0
	const data = bytes.slice(start, length === undefined ? undefined : start + length)
	return encoding === undefined ? data : decodeFileBytes(data, encoding)
}

/** A decoder-only JavaScript path also works in browsers without native Brotli streams. */
export async function readWebCompressedFile(options: ReadWebFileOptions & { compressionAlgorithm?: string }): Promise<ArrayBuffer> {
	if (options.compressionAlgorithm !== 'br') throw new Error('compressionAlgorithm must be br')
	const resource = await readWebFileResource(options)
	// Fetch removes HTTP content encodings before exposing the body. Static servers
	// commonly serve .br files with this header, so decoding that body again fails.
	// Cross-origin hosts must expose Content-Encoding through CORS. An unknown
	// encoding in the chain prevents Fetch from decoding any of the encodings.
	const contentEncodings = resource.contentEncoding?.split(',').map(encoding => encoding.trim().toLowerCase()) ?? []
	if (contentEncodings.includes('br') && contentEncodings.every(encoding => ['br', 'gzip', 'deflate'].includes(encoding))) {
		return resource.data
	}
	const decoded = decompress(new Uint8Array(resource.data), {})
	if (!(decoded instanceof Uint8Array)) throw new Error('invalid Brotli file')
	return new Uint8Array(decoded).buffer
}
