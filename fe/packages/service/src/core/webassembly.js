/** Install before loading application modules: libpag reads WXWebAssembly at import time. */
export function installWXWebAssembly(scope = globalThis) {
	const native = scope.__diminaWasm
	const browser = scope.WebAssembly
	if (typeof native !== 'function' && !browser) return
	const moduleIds = new WeakMap()
	const exportHandles = new WeakMap()
	const compileCache = new Map()

	function bytes(source) {
		if (Object.prototype.toString.call(source) === '[object ArrayBuffer]') return source
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
		throw new TypeError('WebAssembly requires an ArrayBuffer or typed array')
	}
	function moduleId(module) {
		const id = moduleIds.get(module)
		if (id === undefined) throw new TypeError('Expected a WebAssembly.Module')
		return id
	}
	function handle(value) {
		const result = exportHandles.get(value)
		if (!result) throw new TypeError('Expected a WebAssembly export')
		return result
	}
	class CompileError extends Error { constructor(message) { super(message); this.name = 'CompileError' } }
	class LinkError extends Error { constructor(message) { super(message); this.name = 'LinkError' } }
	class RuntimeError extends Error { constructor(message) { super(message); this.name = 'RuntimeError' } }
	class Module {
		constructor(source) { moduleIds.set(this, native('compile', bytes(source))) }
		static imports(module) { return native('imports', moduleId(module)) }
		static exports(module) { return native('exports', moduleId(module)) }
	}
	class Memory {
		constructor() { throw new TypeError('Memory must be defined and exported by the Wasm module') }
		get buffer() { const h = handle(this); return native('buffer', h.instance, h.index) }
		grow(delta) { const h = handle(this); return native('grow', h.instance, h.index, delta) }
	}
	class Table {
		constructor() { throw new TypeError('Table must be defined and exported by the Wasm module') }
		get length() { const h = handle(this); return native('tableSize', h.instance, h.index) }
		get(index) {
			const h = handle(this)
			const functionIndex = native('tableGet', h.instance, h.index, index)
			return functionIndex === null ? null : h.functionAt(functionIndex)
		}
	}
	class Global {
		constructor() { throw new TypeError('Global must be defined and exported by the Wasm module') }
		get value() { const h = handle(this); return native('globalGet', h.instance, h.index) }
		set value(value) { const h = handle(this); native('globalSet', h.instance, h.index, value) }
		valueOf() { return this.value }
	}
	class Instance {
		constructor(module, imports = {}) {
			const imported = Module.imports(module).map(({ module: namespace, name }) => imports[namespace]?.[name])
			const instance = native('instantiate', moduleId(module), imported)
			const functions = new Map()
			function functionAt(index) {
				if (!functions.has(index)) functions.set(index, (...args) => native('call', instance, index, args))
				return functions.get(index)
			}
			const exports = Object.create(null)
			Module.exports(module).forEach(({ name, kind }, index) => {
				let value
				if (kind === 'function') value = functionAt(native('functionIndex', instance, index))
				else {
					const proto = { memory: Memory, table: Table, global: Global }[kind]?.prototype
					if (!proto) throw new LinkError(`Unsupported export: ${kind}`)
					value = Object.create(proto)
					exportHandles.set(value, { instance, index, functionAt })
				}
				Object.defineProperty(exports, name, { value, enumerable: true })
			})
			Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true })
		}
	}

	async function read(source) {
		if (typeof source !== 'string') return bytes(source)
		const virtualPrefix = scope.__VIRTUAL_FILE_PREFIX__ || /^[a-z][a-z\d+.-]*:\/\//i.exec(scope.wx?.env?.USER_DATA_PATH || '')?.[0]
		if (!source || (/^[a-z][a-z\d+.-]*:\/\//i.test(source) && !(virtualPrefix && source.startsWith(virtualPrefix)))) throw new TypeError('Wasm requires a local package or sandbox file path')
		const fs = scope.wx?.getFileSystemManager()
		if (!fs) throw new Error('FileSystemManager is unavailable')
		const method = source.endsWith('.br') ? 'readCompressedFile' : 'readFile'
		const options = { filePath: source }
		if (method === 'readCompressedFile') options.compressionAlgorithm = 'br'
		return new Promise((resolve, reject) => {
			fs[method]({ ...options, success: result => {
				try { resolve(bytes(result.data)) }
				catch (error) { reject(error) }
			}, fail: error => reject(new Error(error.errMsg || `Unable to read ${source}`)) })
		})
	}
	const engine = typeof native === 'function' ? { Module, Instance, Memory, Table, Global, CompileError, LinkError, RuntimeError } : browser
	async function compile(source) {
		// Share only in-flight reads; later calls see updates to writable sandbox files.
		if (typeof source !== 'string') return new engine.Module(await read(source))
		if (!compileCache.has(source)) {
			const pending = read(source).then(data => new engine.Module(data))
			compileCache.set(source, pending)
			pending.then(() => compileCache.delete(source), () => compileCache.delete(source))
		}
		return compileCache.get(source)
	}
	const api = {
		Module: engine.Module, Instance: engine.Instance, Memory: engine.Memory, Table: engine.Table, Global: engine.Global,
		CompileError: engine.CompileError, LinkError: engine.LinkError, RuntimeError: engine.RuntimeError,
		compile,
		async instantiate(source, imports = {}) {
			if (source instanceof engine.Module) return new engine.Instance(source, imports)
			const module = await compile(source)
			return { module, instance: new engine.Instance(module, imports) }
		},
		validate(source) {
			const data = bytes(source)
			return typeof native === 'function' ? native('validate', data) : browser.validate(data)
		},
	}
	Object.defineProperty(scope, 'WXWebAssembly', { value: Object.freeze(api), configurable: true })
	return api
}

installWXWebAssembly()
