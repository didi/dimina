// Production ArkTS path and file bridge, with host filesystem/Brotli adapters.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)
function load(path, dependencies) {
  const { code } = transformSync(fs.readFileSync(new URL(path, root), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Uint8Array, ArrayBuffer, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return module.exports
}

test('reads package Wasm and Brotli for the active app version and confines writes and symlinks', () => {
  const temporary = fs.mkdtempSync(join(tmpdir(), 'dimina-wasm-package-'))
  try {
    const packageRoot = join(temporary, 'packages/owner/v1')
    fs.mkdirSync(join(packageRoot, 'main/utils'), { recursive: true })
    const binary = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
    fs.writeFileSync(join(packageRoot, 'main/utils/module.wasm'), binary)
    fs.writeFileSync(join(packageRoot, 'main/utils/module.wasm.br'), brotliCompressSync(binary))
    const fileAdapter = {
      accessSync: fs.existsSync, mkdirSync: (path, recursive) => fs.mkdirSync(path, { recursive }),
      statSync: fs.statSync, lstatSync: fs.lstatSync,
      OpenMode: { READ_ONLY: 0, READ_WRITE: 1, CREATE: 2 },
      openSync: (path, mode) => ({ fd: fs.openSync(path, mode & 2 ? 'w+' : mode & 1 ? 'r+' : 'r') }),
      readSync: (fd, bytes, options) => fs.readSync(fd, new Uint8Array(bytes), 0, options.length, options.offset),
      writeSync: (fd, bytes, options) => fs.writeSync(fd, new Uint8Array(bytes), 0, options.length, options.offset),
      truncateSync: fs.truncateSync,
      closeSync: value => fs.closeSync(value.fd),
    }
    const virtual = {
      DMPVirtualFileConfig: { getPrefix: () => 'difile://' },
      DMPFileUrlConvertor: { localPathFromVPath: () => { throw new Error('unknown virtual path') } },
    }
    const context = { DMPContextUtils: { getUIAbilityContext: () => ({ filesDir: temporary, cacheDir: temporary }) } }
    const { DMPFilePathResolver } = load('Bundle/Util/DMPFilePathResolver.ets', {
      '@ohos.file.fs': fileAdapter, '../../Utils/DMPContextUtils': context,
      './DMPFileUrlConvertor': virtual,
    })
    const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
    class Base {
      constructor(app) { this.appData = app }
      currentAppId() { return this.appData.appId }
    }
    const { DMPContainerBridgesModuleFile } = load('Bridges/DMPContainerBridgesModule+File.ets', {
      '@ohos.file.fs': fileAdapter, '@ohos.security.cryptoFramework': {}, '@kit.ArkTS': { util: {} },
      '@kit.CoreFileKit': {}, '@kit.PreviewKit': {},
      'libdimina.so': { brotliDecompress: bytes => {
        const output = new Uint8Array(brotliDecompressSync(new Uint8Array(bytes)))
        return output.buffer
      } },
      './DMPContainerBridgesModule': { DMPContainerBridgesModule: Base },
      './DMPTSUtil': {}, '../Utils/DMPMap': { DMPMap }, '../Utils/DMPContextUtils': context,
      '../Bundle/Util/DMPUnzipManager': {},
      '../Bundle/Util/DMPFilePathResolver': { DMPFilePathResolver },
      '../Bundle/Util/DMPFileUrlConvertor': virtual,
      '../Bundle/Util/DMPFileManager': { DMPFileManager: { sharedInstance: () => ({
        getJSAppVersionDir: (id, version) => { assert.equal(id, 'owner'); assert.equal(version, 'v1'); return packageRoot },
      }) } },
    })
    const bridge = new DMPContainerBridgesModuleFile({ appId: 'owner', jsAppVersion: 'v1' })
    const large = new Uint8Array(8 * 1024 * 1024).fill(173)
    large[0] = 0; large[large.length - 1] = 255
    const filePath = 'difile://usr/large.bin'
    bridge.writeFileSync(new DMPMap({ filePath, data: large.buffer }))
    assert.deepEqual(Buffer.from(bridge.readFileSync(new DMPMap({ filePath }))), Buffer.from(large))
    const fd = bridge.openSync(new DMPMap({ filePath, flag: 'r' }))
    const part = bridge.readSync(new DMPMap({ fd, position: large.length - 2, length: 10 }))
    assert.equal(part.get('bytesRead'), 2)
    assert.deepEqual(new Uint8Array(part.get('arrayBuffer')), Uint8Array.of(173, 255))
    bridge.closeSync(new DMPMap({ fd }))
    const compressed = bridge.readCompressedFileSync(new DMPMap({ filePath: '/utils/module.wasm.br', compressionAlgorithm: 'br' }))
    assert.deepEqual(Buffer.from(compressed), binary)
    for (const path of ['utils/module.wasm', '/utils/module.wasm']) {
      assert.deepEqual(Buffer.from(bridge.readFileSync(new DMPMap({ filePath: path }))), binary)
    }
    assert.throws(() => bridge.readFileSync(new DMPMap({ filePath: '../other/module.wasm' })), /invalid file path/)
    assert.throws(() => bridge.writeFileSync(new DMPMap({ filePath: '/utils/module.wasm', data: 'changed' })), /permission denied/)
    fs.writeFileSync(join(temporary, 'outside.wasm'), binary)
    fs.symlinkSync(join(temporary, 'outside.wasm'), join(packageRoot, 'main/utils/escape.wasm'))
    assert.throws(() => bridge.readFileSync(new DMPMap({ filePath: '/utils/escape.wasm' })), /symbolic links/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
