import { invokeAPI } from '@/api/common'

const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'
const FILE_DATA_BASE64_KEY = '__diminaFileDataBase64'
const FILE_DATA_TYPE_KEY = '__diminaFileDataType'

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
	const lookup = {}
	for (let i = 0; i < BASE64_CHARS.length; i++) {
		lookup[BASE64_CHARS[i]] = i
	}
	return lookup
})()

function isArrayBuffer(value) {
	return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function isArrayBufferView(value) {
	return value && value.buffer && isArrayBuffer(value.buffer)
}

function toArrayBuffer(value) {
	if (isArrayBuffer(value)) {
		return value
	}
	if (isArrayBufferView(value)) {
		return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
	}
	return null
}

function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer)
	let result = ''
	let i = 0
	for (; i + 2 < bytes.length; i += 3) {
		result += BASE64_CHARS[bytes[i] >> 2]
		result += BASE64_CHARS[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)]
		result += BASE64_CHARS[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)]
		result += BASE64_CHARS[bytes[i + 2] & 63]
	}
	if (i < bytes.length) {
		result += BASE64_CHARS[bytes[i] >> 2]
		if (i + 1 < bytes.length) {
			result += BASE64_CHARS[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)]
			result += BASE64_CHARS[(bytes[i + 1] & 15) << 2]
			result += '='
		}
		else {
			result += BASE64_CHARS[(bytes[i] & 3) << 4]
			result += '=='
		}
	}
	return result
}

function base64ToArrayBuffer(base64) {
	const clean = String(base64 || '').replace(/[\r\n\s]/g, '')
	if (!clean) {
		return new ArrayBuffer(0)
	}

	const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
	const length = (clean.length * 3 / 4) - padding
	const bytes = new Uint8Array(length)
	let byteIndex = 0

	for (let i = 0; i < clean.length; i += 4) {
		const c1 = BASE64_LOOKUP[clean[i]]
		const c2 = BASE64_LOOKUP[clean[i + 1]]
		const c3 = clean[i + 2] === '=' ? 0 : BASE64_LOOKUP[clean[i + 2]]
		const c4 = clean[i + 3] === '=' ? 0 : BASE64_LOOKUP[clean[i + 3]]

		if (byteIndex < length) bytes[byteIndex++] = (c1 << 2) | (c2 >> 4)
		if (byteIndex < length) bytes[byteIndex++] = ((c2 & 15) << 4) | (c3 >> 2)
		if (byteIndex < length) bytes[byteIndex++] = ((c3 & 3) << 6) | c4
	}

	return bytes.buffer
}

function encodeFileData(data) {
	const buffer = toArrayBuffer(data)
	if (!buffer) {
		return data
	}
	return {
		[FILE_DATA_TYPE_KEY]: 'base64',
		[FILE_DATA_BASE64_KEY]: arrayBufferToBase64(buffer),
	}
}

function normalizeWriteOptions(opts, keys = ['data', 'arrayBuffer']) {
	if (!opts || typeof opts !== 'object') {
		return opts
	}

	const next = { ...opts }
	for (const key of keys) {
		if (key in next) {
			next[key] = encodeFileData(next[key])
		}
	}
	return next
}

function decodeArrayBufferPayload(value) {
	if (value && typeof value === 'object' && value[ARRAY_BUFFER_BASE64_KEY] !== undefined) {
		return base64ToArrayBuffer(value[ARRAY_BUFFER_BASE64_KEY])
	}
	return value
}

function normalizeReadFileResult(res) {
	if (res && typeof res === 'object' && res.data !== undefined) {
		return {
			...res,
			data: decodeArrayBufferPayload(res.data),
		}
	}
	return res
}

function normalizeReadZipEntryResult(res) {
	if (!res || typeof res !== 'object' || !res.entries || typeof res.entries !== 'object') {
		return res
	}

	const entries = {}
	for (const [path, item] of Object.entries(res.entries)) {
		if (item && typeof item === 'object' && item.data !== undefined) {
			entries[path] = {
				...item,
				data: decodeArrayBufferPayload(item.data),
			}
		}
		else {
			entries[path] = item
		}
	}
	return {
		...res,
		entries,
	}
}

function fillReadArrayBuffer(res, arrayBuffer, offset = 0) {
	if (!res || typeof res !== 'object' || !arrayBuffer || res[ARRAY_BUFFER_BASE64_KEY] === undefined) {
		return res
	}

	const data = new Uint8Array(base64ToArrayBuffer(res[ARRAY_BUFFER_BASE64_KEY]))
	new Uint8Array(arrayBuffer).set(data, offset)
	const { [ARRAY_BUFFER_BASE64_KEY]: _, ...rest } = res
	return {
		...rest,
		arrayBuffer,
	}
}

function normalizeReadOptions(opts) {
	const next = { ...opts }
	const buffer = toArrayBuffer(opts?.arrayBuffer)
	if (buffer) {
		next.arrayBufferLength = buffer.byteLength
		delete next.arrayBuffer
	}
	return next
}

class Stats {
	constructor(raw = {}) {
		this.mode = raw.mode
		this.size = raw.size
		this.lastAccessedTime = raw.lastAccessedTime
		this.lastModifiedTime = raw.lastModifiedTime
		this._isDirectory = !!raw.isDirectory
		this._isFile = !!raw.isFile
	}

	isDirectory() {
		return this._isDirectory
	}

	isFile() {
		return this._isFile
	}
}

function isStatsLike(value) {
	return value
		&& typeof value === 'object'
		&& typeof value.size === 'number'
		&& Object.prototype.hasOwnProperty.call(value, 'isDirectory')
		&& Object.prototype.hasOwnProperty.call(value, 'isFile')
}

function hydrateStats(value) {
	if (!value || typeof value !== 'object') {
		return value
	}
	if (typeof value.isDirectory === 'function' && typeof value.isFile === 'function') {
		return value
	}
	if (isStatsLike(value)) {
		return new Stats(value)
	}
	if (Array.isArray(value)) {
		return value.map(item => hydrateStats(item))
	}
	const next = {}
	for (const [key, item] of Object.entries(value)) {
		next[key] = hydrateStats(item)
	}
	return next
}

function normalizeStatsResult(res) {
	if (res && typeof res === 'object') {
		if (res.stats !== undefined) {
			return { ...res, stats: hydrateStats(res.stats) }
		}
		if (res.statsMap !== undefined) {
			return { ...res, statsMap: hydrateStats(res.statsMap) }
		}
	}
	return hydrateStats(res)
}

function withSuccessTransform(opts, transform) {
	if (!opts || typeof opts !== 'object') {
		return opts
	}
	const next = { ...opts }
	if (typeof opts.success === 'function') {
		next.success = res => opts.success(transform(res))
	}
	if (typeof opts.complete === 'function') {
		next.complete = res => opts.complete(transform(res))
	}
	return next
}

function invokeFileAPI(name, opts, { transform = res => res, prepare = data => data } = {}) {
	const prepared = prepare(withSuccessTransform(opts, transform))
	const result = invokeAPI(name, prepared)
	if (result && typeof result.then === 'function') {
		return result.then(transform)
	}
	return result
}

function invokeReadAPI(name, opts) {
	const arrayBuffer = opts?.arrayBuffer
	const offset = opts?.offset || 0
	return invokeFileAPI(name, opts, {
		prepare: normalizeReadOptions,
		transform: res => fillReadArrayBuffer(res, arrayBuffer, offset),
	})
}

/**
 * 文件系统管理器
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.html
 */
class FileSystemManager {
	/**
	 * 判断文件/目录是否存在
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.access.html
	 */
	access(opts) {
		return invokeFileAPI('FileSystemManager.access', opts)
	}

	/**
	 * 同步判断文件/目录是否存在
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.accessSync.html
	 */
	accessSync(path) {
		return invokeAPI('FileSystemManager.accessSync', path)
	}

	/**
	 * 在文件结尾追加内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.appendFile.html
	 */
	appendFile(opts) {
		return invokeFileAPI('FileSystemManager.appendFile', opts, { prepare: normalizeWriteOptions })
	}

	/**
	 * 同步在文件结尾追加内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.appendFileSync.html
	 */
	appendFileSync(filePath, data, encoding) {
		return invokeAPI('FileSystemManager.appendFileSync', normalizeWriteOptions({ filePath, data, encoding }))
	}

	/**
	 * 关闭文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.close.html
	 */
	close(opts) {
		return invokeFileAPI('FileSystemManager.close', opts)
	}

	/**
	 * 同步关闭文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.closeSync.html
	 */
	closeSync(opts) {
		return invokeAPI('FileSystemManager.closeSync', opts)
	}

	/**
	 * 复制文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.copyFile.html
	 */
	copyFile(opts) {
		return invokeFileAPI('FileSystemManager.copyFile', opts)
	}

	/**
	 * 同步复制文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.copyFileSync.html
	 */
	copyFileSync(srcPath, destPath) {
		return invokeAPI('FileSystemManager.copyFileSync', { srcPath, destPath })
	}

	/**
	 * 获取文件的状态信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.fstat.html
	 */
	fstat(opts) {
		return invokeFileAPI('FileSystemManager.fstat', opts, { transform: normalizeStatsResult })
	}

	/**
	 * 同步获取文件的状态信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.fstatSync.html
	 */
	fstatSync(opts) {
		return normalizeStatsResult(invokeAPI('FileSystemManager.fstatSync', opts))
	}

	/**
	 * 对文件内容进行截断操作
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.ftruncate.html
	 */
	ftruncate(opts) {
		return invokeFileAPI('FileSystemManager.ftruncate', opts)
	}

	/**
	 * 对文件内容进行截断操作(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.ftruncateSync.html
	 */
	ftruncateSync(opts) {
		return invokeAPI('FileSystemManager.ftruncateSync', opts)
	}

	/**
	 * 获取该小程序下的本地临时文件或本地缓存文件信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.getFileInfo.html
	 */
	getFileInfo(opts) {
		return invokeFileAPI('FileSystemManager.getFileInfo', opts)
	}

	/**
	 * 获取该小程序下已保存的本地缓存文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.getSavedFileList.html
	 */
	getSavedFileList(opts) {
		return invokeFileAPI('FileSystemManager.getSavedFileList', opts || {})
	}

	/**
	 * 创建目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.mkdir.html
	 */
	mkdir(opts) {
		return invokeFileAPI('FileSystemManager.mkdir', opts)
	}

	/**
	 * 同步创建目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.mkdirSync.html
	 */
	mkdirSync(dirPath, recursive) {
		return invokeAPI('FileSystemManager.mkdirSync', { dirPath, recursive })
	}

	/**
	 * 打开文件,返回文件描述符
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.open.html
	 */
	open(opts) {
		return invokeFileAPI('FileSystemManager.open', opts)
	}

	/**
	 * 同步打开文件,返回文件描述符
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.openSync.html
	 */
	openSync(opts) {
		return invokeAPI('FileSystemManager.openSync', opts)
	}

	/**
	 * 读文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.read.html
	 */
	read(opts) {
		return invokeReadAPI('FileSystemManager.read', opts)
	}

	/**
	 * 读文件(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readSync.html
	 */
	readSync(opts) {
		return fillReadArrayBuffer(
			invokeAPI('FileSystemManager.readSync', normalizeReadOptions(opts)),
			opts?.arrayBuffer,
			opts?.offset || 0,
		)
	}

	/**
	 * 读取指定压缩类型的本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readCompressedFile.html
	 */
	readCompressedFile(opts) {
		return invokeFileAPI('FileSystemManager.readCompressedFile', opts, { transform: normalizeReadFileResult })
	}

	/**
	 * 同步读取指定压缩类型的本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readCompressedFileSync.html
	 */
	readCompressedFileSync(opts) {
		return decodeArrayBufferPayload(invokeAPI('FileSystemManager.readCompressedFileSync', opts))
	}

	/**
	 * 读取目录内文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readdir.html
	 */
	readdir(opts) {
		return invokeFileAPI('FileSystemManager.readdir', opts)
	}

	/**
	 * 同步读取目录内文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readdirSync.html
	 */
	readdirSync(dirPath) {
		return invokeAPI('FileSystemManager.readdirSync', dirPath)
	}

	/**
	 * 读取本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html
	 */
	readFile(opts) {
		return invokeFileAPI('FileSystemManager.readFile', opts, { transform: normalizeReadFileResult })
	}

	/**
	 * 同步读取本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFileSync.html
	 */
	readFileSync(filePath, encoding, position, length) {
		return decodeArrayBufferPayload(invokeAPI('FileSystemManager.readFileSync', { filePath, encoding, position, length }))
	}

	/**
	 * 读取压缩包内的文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readZipEntry.html
	 */
	readZipEntry(opts) {
		return invokeFileAPI('FileSystemManager.readZipEntry', opts, { transform: normalizeReadZipEntryResult })
	}

	/**
	 * 删除该小程序下已保存的本地缓存文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.removeSavedFile.html
	 */
	removeSavedFile(opts) {
		return invokeFileAPI('FileSystemManager.removeSavedFile', opts)
	}

	/**
	 * 重命名文件。可以把文件从 oldPath 移动到 newPath
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rename.html
	 */
	rename(opts) {
		return invokeFileAPI('FileSystemManager.rename', opts)
	}

	/**
	 * 同步重命名文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.renameSync.html
	 */
	renameSync(oldPath, newPath) {
		return invokeAPI('FileSystemManager.renameSync', { oldPath, newPath })
	}

	/**
	 * 删除目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rmdir.html
	 */
	rmdir(opts) {
		return invokeFileAPI('FileSystemManager.rmdir', opts)
	}

	/**
	 * 同步删除目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rmdirSync.html
	 */
	rmdirSync(dirPath, recursive) {
		return invokeAPI('FileSystemManager.rmdirSync', { dirPath, recursive })
	}

	/**
	 * 保存临时文件到本地
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.saveFile.html
	 */
	saveFile(opts) {
		return invokeFileAPI('FileSystemManager.saveFile', opts)
	}

	/**
	 * 同步保存临时文件到本地
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.saveFileSync.html
	 */
	saveFileSync(tempFilePath, filePath) {
		return invokeAPI('FileSystemManager.saveFileSync', { tempFilePath, filePath })
	}

	/**
	 * 获取文件 Stats 对象
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.stat.html
	 */
	stat(opts) {
		return invokeFileAPI('FileSystemManager.stat', opts, { transform: normalizeStatsResult })
	}

	/**
	 * 同步获取文件 Stats 对象
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.statSync.html
	 */
	statSync(path, recursive) {
		return normalizeStatsResult(invokeAPI('FileSystemManager.statSync', { path, recursive }))
	}

	/**
	 * 对文件内容进行截断操作
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.truncate.html
	 */
	truncate(opts) {
		return invokeFileAPI('FileSystemManager.truncate', opts)
	}

	/**
	 * 对文件内容进行截断操作(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.truncateSync.html
	 */
	truncateSync(filePath, length) {
		return invokeAPI('FileSystemManager.truncateSync', { filePath, length })
	}

	/**
	 * 删除文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unlink.html
	 */
	unlink(opts) {
		return invokeFileAPI('FileSystemManager.unlink', opts)
	}

	/**
	 * 同步删除文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unlinkSync.html
	 */
	unlinkSync(filePath) {
		return invokeAPI('FileSystemManager.unlinkSync', filePath)
	}

	/**
	 * 解压文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unzip.html
	 */
	unzip(opts) {
		return invokeFileAPI('FileSystemManager.unzip', opts)
	}

	/**
	 * 写入文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.write.html
	 */
	write(opts) {
		return invokeFileAPI('FileSystemManager.write', opts, { prepare: data => normalizeWriteOptions(data, ['arrayBuffer', 'data']) })
	}

	/**
	 * 同步写入文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeSync.html
	 */
	writeSync(opts) {
		return invokeAPI('FileSystemManager.writeSync', normalizeWriteOptions(opts, ['arrayBuffer', 'data']))
	}

	/**
	 * 写文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFile.html
	 */
	writeFile(opts) {
		return invokeFileAPI('FileSystemManager.writeFile', opts, { prepare: normalizeWriteOptions })
	}

	/**
	 * 同步写文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFileSync.html
	 */
	writeFileSync(filePath, data, encoding) {
		return invokeAPI('FileSystemManager.writeFileSync', normalizeWriteOptions({ filePath, data, encoding }))
	}
}

export const fileSystemManagerAPINames = Object
	.getOwnPropertyNames(FileSystemManager.prototype)
	.filter(name => name !== 'constructor')

let fileSystemManagerInstance = null

/**
 * 获取全局唯一的文件管理器
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html
 */
export function getFileSystemManager() {
	if (!fileSystemManagerInstance) {
		fileSystemManagerInstance = new FileSystemManager()
	}
	return fileSystemManagerInstance
}
