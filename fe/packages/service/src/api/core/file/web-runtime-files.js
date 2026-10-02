// Synchronous files created by the current Web Worker. Persistent OPFS and
// package files continue to use the asynchronous container filesystem.
const files = new Map()
const directories = new Set()
const MAX_BYTES = 128 * 1024 * 1024
let totalBytes = 0

export function createRuntimeFiles(root) {
	directories.add(root)
	function path(value) {
		if (typeof value !== 'string') throw new TypeError('file path must be a string')
		const normalized = value.replace(/\/+$/, '')
		if (normalized !== root && !normalized.startsWith(`${root}/`)) throw new Error('file path must be under USER_DATA_PATH')
		const segments = normalized.slice(root.length).split('/').slice(1)
		if (segments.some(segment => !segment || /[\\\/\0]/.test(decodeURIComponent(segment)) || ['.', '..'].includes(decodeURIComponent(segment)))) throw new Error('invalid file path')
		return normalized
	}
	const parent = value => value.slice(0, value.lastIndexOf('/'))
	return {
		has: value => files.has(path(value)),
		access(value) { const key = path(value); if (!files.has(key) && !directories.has(key)) throw new Error('no such runtime file or directory') },
		mkdir(value, recursive = false) {
			const key = path(value)
			if (files.has(key) || (directories.has(key) && !recursive)) throw new Error('file already exists')
			if (!directories.has(parent(key))) { if (!recursive) throw new Error('parent directory does not exist'); this.mkdir(parent(key), true) }
			directories.add(key)
		},
		write(value, data, encoding = 'utf8') {
			const key = path(value)
			if (!directories.has(parent(key)) || directories.has(key)) throw new Error('invalid destination directory')
			const available = MAX_BYTES - totalBytes + (files.get(key)?.byteLength || 0)
			const size = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength : typeof data === 'string' ? data.length : 0
			if (size > available) throw new RangeError('runtime file storage exceeds 128 MiB')
			let bytes
			if (data instanceof ArrayBuffer) bytes = data.slice(0)
			else if (ArrayBuffer.isView(data)) bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
			else if (typeof data === 'string' && /^(utf-?8)$/i.test(encoding)) bytes = new TextEncoder().encode(data).buffer
			else throw new TypeError('runtime files require binary data or UTF-8 text')
			const next = totalBytes - (files.get(key)?.byteLength || 0) + bytes.byteLength
			if (next > MAX_BYTES) throw new RangeError('runtime file storage exceeds 128 MiB')
			files.set(key, bytes)
			totalBytes = next
		},
		read(value, encoding, position = 0, length) {
			const data = files.get(path(value))
			if (!data) throw new Error('no such runtime file')
			if (!Number.isSafeInteger(position) || position < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new RangeError('invalid file range')
			const bytes = data.slice(position, length === undefined ? data.byteLength : position + length)
			if (encoding === undefined || encoding === '') return bytes
			if (!/^(utf-?8)$/i.test(encoding)) throw new TypeError('runtime text encoding must be UTF-8')
			return new TextDecoder().decode(bytes)
		},
		unlink(value) { const key = path(value); this.access(key); if (!files.has(key)) throw new Error('path is a directory'); totalBytes -= files.get(key).byteLength; files.delete(key) },
		readdir(value) {
			const key = path(value)
			if (!directories.has(key)) throw new Error('no such directory')
			return [...files.keys(), ...directories].filter(candidate => candidate !== key && parent(candidate) === key).map(candidate => candidate.slice(key.length + 1))
		},
	}
}
