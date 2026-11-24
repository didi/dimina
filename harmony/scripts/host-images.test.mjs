import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
class Response {
  setResponseData(value) { this.data = value }
  setResponseMimeType(value) { this.mime = value }
  setResponseCode(value) { this.code = value }
  setReasonMessage(value) { this.reason = value }
  setResponseIsReady(value) { this.ready = value }
}
function load(path, dependencies) {
  const source = fs.readFileSync(new URL(`../dimina/src/main/ets/${path}`, import.meta.url), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, ArrayBuffer, Uint8Array, WebResourceResponse: Response,
    require: name => { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  return module.exports
}
async function completed(response) {
  assert.ok(response)
  for (let turn = 0; !response.ready && turn < 100; turn++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(response.ready, true)
  return response
}
function fixture() {
  let opened = 0, closed = 0
  const adapter = {
    statSync: fs.statSync, lstatSync: fs.lstatSync, OpenMode: { READ_ONLY: 0 },
    open: async path => { const fd = fs.openSync(path, 'r'); opened++; return { fd } },
    stat: async fd => fs.fstatSync(fd),
    read: async (fd, buffer, options) => fs.readSync(fd, new Uint8Array(buffer), 0, Math.min(2, options.length), null),
    close: async file => { fs.closeSync(file.fd); closed++ },
  }
  const registry = load('Render/DMPHostImages.ets', { '@ohos.file.fs': adapter, '@ohos.resourceManager': {} })
  const localMedia = load('Render/UrlIntercepter/LocalMediaResponse.ets', {
    '@ohos.file.fs': adapter, '../../Bundle/Util/DMPFilePathResolver': {},
  })
  const { RequestCallback } = load('Render/UrlIntercepter/UrlInterceptor.ets', {
    '@ohos.file.fs': adapter, '@ohos.multimedia.image': {},
    '../../DApp/DMPAppManager': { DMPAppManager: { sharedInstance: () => ({ getApp: () => ({}) }) } },
    '../../EventTrack/DMPLogger': { DMPLogger: { d() {} } }, '../../EventTrack/Tags': { Tags: {} },
    '../../Bundle/Util/DMPFilePathResolver': {},
    '../../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: { getPrefix: () => 'difile://' } },
    '../DMPHostFonts': { DMPHostFonts: { intercept: () => null } }, '../DMPHostImages': registry,
    './LocalMediaResponse': localMedia,
  })
  return {
    images: registry.DMPHostImages,
    request: key => new RequestCallback(1).callback({ request: { getRequestUrl: () => `http://127.0.0.1/__dimina_host_images/${key}` } }),
    counts: () => [opened, closed],
  }
}

test('host registry routes rawfile images and nested rawfile directories without copying files', async () => {
  const { images, request } = fixture()
  const resource = { id: -1, params: ['icons/light.svg'] }
  images.registerRawFile('Light_ON', resource, 'svg')
  const exact = await completed(request('Light_ON'))
  assert.equal(exact.code, 200)
  assert.equal(exact.mime, 'image/svg+xml')
  assert.equal(exact.data, resource)
  const paths = []
  images.registerRawDirectory('icons', {
    isRawDir: path => path === 'art',
    getRawFileContent: async path => { paths.push(path); return Uint8Array.from([99, 1, 2, 3, 99]).subarray(1, 4) },
  }, 'art')
  const nested = await completed(request('icons/nested/%E7%81%AF%20on.WeBp?v=1'))
  assert.equal(nested.code, 200)
  assert.equal(nested.mime, 'image/webp')
  assert.deepEqual([...new Uint8Array(nested.data)], [1, 2, 3])
  assert.deepEqual(paths, ['art/nested/灯 on.WeBp'])
  for (const key of ['icons/../outside.png', 'icons/%2e%2e/outside.png', 'icons/%252e%252e/x.png', 'icons/a%2fb.png', 'icons//x.png', 'icons/a\\b.png', 'icons/a%00.png', 'icons/%zz', 'icons/secret.json', 'Light_ON/extra.png', 'icons']) {
    assert.equal((await completed(request(key))).code, 404, key)
  }
  images.unregister('Light_ON')
  assert.equal((await completed(request('Light_ON'))).code, 404)
  assert.equal(images.intercept('https://untrusted.example/__dimina_host_images/icons/a.png'), null)
  assert.equal(images.intercept('http://127.0.0.1/ordinary.png'), null)
})

test('host file directories confine symlinks, stream partial reads, and close failed reads', async () => {
  const { images, request, counts } = fixture()
  const temporary = fs.mkdtempSync(join(tmpdir(), 'dimina-host-images-'))
  try {
    const root = join(temporary, 'images')
    fs.mkdirSync(join(root, 'nested'), { recursive: true })
    fs.writeFileSync(join(root, 'nested/a.jpg'), Uint8Array.from([1, 2, 3, 4, 5]))
    fs.writeFileSync(join(temporary, 'outside.png'), 'private')
    fs.symlinkSync(join(temporary, 'outside.png'), join(root, 'escape.png'))
    images.registerDirectory('icons', root)
    let response = await completed(request('icons/nested/a.jpg'))
    assert.equal(response.code, 200)
    assert.equal(response.mime, 'image/jpeg')
    assert.deepEqual([...new Uint8Array(response.data)], [1, 2, 3, 4, 5])
    assert.deepEqual(counts(), [1, 1])
    assert.equal((await completed(request('icons/escape.png'))).code, 404)
    assert.equal((await completed(request('icons/missing.png'))).code, 404)
    images.registerFile('file', join(root, 'nested/a.jpg'))
    fs.unlinkSync(join(root, 'nested/a.jpg'))
    response = await completed(request('file'))
    assert.equal(response.code, 404)
    assert.deepEqual(counts(), [1, 1])
    images.registerFile('directory-after-register', join(temporary, 'outside.png'))
    fs.unlinkSync(join(temporary, 'outside.png'))
    fs.mkdirSync(join(temporary, 'outside.png'))
    assert.equal((await completed(request('directory-after-register'))).code, 404)
    assert.deepEqual(counts(), [2, 2])
    assert.throws(() => images.registerRawFile('../bad', {}, 'png'), /ID/)
    assert.throws(() => images.registerRawFile('bad', {}, 'html'), /format/)
    assert.throws(() => images.registerDirectory('bad', `${root}/..`), /path/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
