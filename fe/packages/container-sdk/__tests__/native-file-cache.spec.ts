import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Real ArkTS dispatch and file logic; OHOS boundaries use local disk and short IO.
const nativeRoot = path.resolve(import.meta.dirname, '../../../../harmony/dimina/src/main/ets')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function load(file: string, imports: Record<string, any>) {
	const code = ts.transpileModule(fs.readFileSync(path.join(nativeRoot, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
	const exports: any = {}
	vm.runInNewContext(code, { exports, require: (name: string) => {
		if (!(name in imports)) throw new Error(`Unmocked boundary: ${name}`)
		return imports[name]
	}, ArrayBuffer, Uint8Array, Object, Map, String, Error, Date, Math })
	return exports
}
class DMPMap {
	constructor(private data: any = {}) {}
	static createFromObject(data: any) { return new DMPMap(data) }
	get(key: string) { return this.data[key] }
	getString(key: string) { return this.data[key] }
	getBoolean(key: string) { return this.data[key] }
	getNumber(key: string) { return this.data[key] }
	set(key: string, value: any) { this.data[key] = value }
}
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-file-cache-')); roots.push(root)
	const handles = new Set<number>(); let failWrite = false; let failRead = false
	const nativeFS = {
		OpenMode: { READ_ONLY: fs.constants.O_RDONLY, READ_WRITE: fs.constants.O_RDWR, CREATE: fs.constants.O_CREAT },
		accessSync: fs.existsSync, statSync: fs.statSync, lstatSync: fs.lstatSync,
		mkdirSync: (name: string, recursive = false) => fs.mkdirSync(name, { recursive }),
		listFileSync: (name: string) => fs.readdirSync(name),
		rmdirSync: fs.rmdirSync, unlinkSync: fs.unlinkSync, copyFileSync: fs.copyFileSync,
		moveFileSync: fs.renameSync, renameSync: fs.renameSync, truncateSync: fs.truncateSync,
		openSync: (name: string, mode: number) => { const fd = fs.openSync(name, mode); handles.add(fd); return { fd } },
		closeSync: (file: { fd: number }) => { fs.closeSync(file.fd); handles.delete(file.fd) },
		writeSync: (fd: number, data: ArrayBuffer, opts: any) => {
			if (failWrite) throw new Error('disk full')
			return fs.writeSync(fd, new Uint8Array(data), 0, Math.min(opts.length, 65536), opts.offset ?? null)
		},
		readSync: (fd: number, data: ArrayBuffer, opts: any) => {
			if (failRead) throw new Error('read failed')
			return fs.readSync(fd, new Uint8Array(data), 0, Math.min(opts.length, 65536), opts.offset ?? null)
		},
	}
	const config = { getPrefix: () => 'difile://' }
	const context = { getUIAbilityContext: () => ({ filesDir: root + '/files', cacheDir: root + '/cache' }) }
	const { DMPFilePathResolver } = load('Bundle/Util/DMPFilePathResolver.ets', {
		'@ohos.file.fs': { __esModule: true, default: nativeFS }, '../../Utils/DMPContextUtils': { DMPContextUtils: context },
		'./DMPFileUrlConvertor': { DMPVirtualFileConfig: config, DMPFileUrlConvertor: {} },
	})
	class Base {
		constructor(private app: any) {}
		currentAppId() { return this.app.appId }
		invokeSuccessCallback(callback: any, data: any) { callback(data, true) }
		invokeFailureCallback(callback: any, _data: any, error: string) { callback(new DMPMap({ errMsg: error }), false) }
	}
	const { DMPContainerBridgesModuleFile: FileModule } = load('Bridges/DMPContainerBridgesModule+File.ets', {
		'@ohos.file.fs': { __esModule: true, default: nativeFS }, '@ohos.security.cryptoFramework': {},
		'@kit.ArkTS': { util: { TextEncoder: class { encodeInto(text: string) { return new TextEncoder().encode(text) } }, TextDecoder: { create: () => ({ decodeToString: (data: Uint8Array) => new TextDecoder().decode(data) }) } } }, '@kit.CoreFileKit': {}, '@kit.PreviewKit': {},
		'libdimina.so': {}, './DMPContainerBridgesModule': { DMPContainerBridgesModule: Base },
		'../Utils/DMPMap': { DMPMap }, '../Utils/DMPContextUtils': { DMPContextUtils: context },
		'../Bundle/Util/DMPUnzipManager': {}, '../Bundle/Util/DMPFilePathResolver': { DMPFilePathResolver },
		'../Bundle/Util/DMPFileManager': {},
		'../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: config },
	})
	const api = new FileModule({ appId: 'cache-app' })
	function call(name: string, params: any, ok = true) {
		let result: any, outcome: boolean | undefined
		api.dispatchFileSystemManager(`FileSystemManager.${name}`, new DMPMap(params), (data: any, succeeded: boolean) => {
			outcome = succeeded; result = data
		})
		expect(result).toBeDefined(); expect(outcome, result.get('errMsg')).toBe(ok); return result
	}
	return { call, handles, failWrites: () => { failWrite = true }, failReads: () => { failRead = true } }
}
it('persists a 2 MB UTF-8 cache and implements the directory lifecycle', () => {
	const { call, handles } = fixture()
	const base = 'difile://usr/form-cache', file = base + '/form.json'
	const text = JSON.stringify({ form: 'x'.repeat(2 * 1024 * 1024) + '中文' })
	call('access', { path: base }, false)
	call('mkdir', { dirPath: base, recursive: true })
	call('writeFile', { filePath: file, data: text, encoding: 'utf8' })
	expect(call('readFile', { filePath: file, encoding: 'utf8' }).get('data')).toBe(text)
	call('writeFile', { filePath: file, data: '{}', encoding: 'utf8' })
	expect(call('readFile', { filePath: file, encoding: 'utf8' }).get('data')).toBe('{}')
	call('copyFile', { srcPath: file, destPath: base + '/copy.json' })
	call('rename', { oldPath: base + '/copy.json', newPath: base + '/renamed.json' })
	expect(call('readdir', { dirPath: base }).get('files')).toHaveLength(2)
	expect(call('stat', { path: base, recursive: true }).get('stats').get('/form.json')?.get('size')).toBe(2)
	call('rmdir', { dirPath: base }, false)
	call('rmdir', { dirPath: file, recursive: true }, false)
	call('unlink', { filePath: base }, false)
	call('access', { path: file })
	call('unlink', { filePath: base + '/renamed.json' })
	call('rmdir', { dirPath: base, recursive: true })
	call('access', { path: file }, false)
	expect(handles.size).toBe(0)
})
it('closes failed writes so the temporary file can be cleaned up', () => {
	const { call, handles, failWrites } = fixture(); failWrites()
	call('writeFile', { filePath: 'difile://usr/cache.tmp', data: 'data', encoding: 'utf8' }, false)
	expect(handles.size).toBe(0)
	call('unlink', { filePath: 'difile://usr/cache.tmp' })
})

it('closes file handles when reading fails', () => {
	const { call, handles, failReads } = fixture()
	call('writeFile', { filePath: 'difile://usr/cache.json', data: '{}', encoding: 'utf8' })
	failReads()
	call('readFile', { filePath: 'difile://usr/cache.json', encoding: 'utf8' }, false)
	expect(handles.size).toBe(0)
})

it('matches DevTools mkdir, copy, rename and root protection semantics', () => {
	const { call } = fixture()
	const root = 'difile://usr', base = root + '/compat', file = base + '/value'
	call('mkdir', { dirPath: base, recursive: true })
	call('mkdir', { dirPath: base, recursive: true }, false)
	call('writeFile', { filePath: file, data: 'original', encoding: 'utf8' })
	call('copyFile', { srcPath: file, destPath: file })
	call('copyFile', { srcPath: base + '/missing', destPath: file }, false)
	expect(call('readFile', { filePath: file, encoding: 'utf8' }).get('data')).toBe('original')
	call('copyFile', { srcPath: file, destPath: base }, false)
	call('writeFile', { filePath: base + '/replacement', data: 'new', encoding: 'utf8' })
	call('rename', { oldPath: base + '/replacement', newPath: file })
	expect(call('readFile', { filePath: file, encoding: 'utf8' }).get('data')).toBe('new')
	for (const protectedRoot of [root, 'difile://tmp']) {
		call('rmdir', { dirPath: protectedRoot, recursive: true }, false)
		call('rename', { oldPath: protectedRoot, newPath: base + '/moved' }, false)
		call('rename', { oldPath: base, newPath: protectedRoot }, false)
	}
	const stats = call('stat', { path: base, recursive: true }).get('stats')
	expect(stats.get('')?.get('isDirectory')).toBe(true)
	expect(stats.get('/value')?.get('mode') & 0o170000).toBe(0o100000)
	expect(call('stat', { path: file, recursive: true }).get('stats').get('size')).toBe(3)
	call('access', { path: file })
})
