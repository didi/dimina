import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storeInfo } from '../src/env.js'
import { initWxsFilePathMap, loadWxsModule } from '../src/core/view-compiler.js'

/**
 * 回归：loadWxsModule 通过文件系统兜底加载「依赖发现」到的 npm 视图脚本时，
 * 旧实现用硬编码的 '_wxs_' 路径片段 + 'miniprogram_npm__' 双下划线做门槛——只对
 * scoped 包(@scope→//→__)且放在 wxs/ 目录的 .wxs 生效。自定义扩展名(.qds)的模块 id
 * 形如 miniprogram_npm_pkg_qds_util（单下划线、无 _wxs_）会被一律拒绝 → 漏编译。
 * 修复后改用 wxsFilePathMap（扫描权威来源）判定 + 定位，与扩展名/命名无关。
 */
describe('npm 视图脚本自定义类型：loadWxsModule 不依赖 _wxs_ 片段', () => {
  let tempDir

  function write(rel, content) {
    const full = path.join(tempDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-vs-custom-'))
    // 最小工程（storeInfo 需要 app.json / project.config.json）
    write('app.json', JSON.stringify({ pages: ['pages/home/index'] }))
    write('project.config.json', JSON.stringify({ appid: 'vs-custom' }))
    write('pages/home/index.json', JSON.stringify({}))
    write('pages/home/index.wxml', '<view>home</view>')
    write('pages/home/index.js', 'Page({})')
    // 非 scoped 包 + qds/ 目录 + .qds 扩展名 → id = miniprogram_npm_pkg_qds_util（无 _wxs_）
    write('miniprogram_npm/pkg/qds/util.qds', 'module.exports = { brand: function () { return 42 } }')
    // 非 wxs/ 目录的 .wxs → id = miniprogram_npm_pkg_helper（旧实现也会漏，顺带证明修复）
    write('miniprogram_npm/pkg/helper.wxs', 'module.exports = { help: function () { return 1 } }')
  })

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('加载自定义扩展名(.qds)的 npm 视图脚本依赖', () => {
    storeInfo(tempDir, { fileTypes: { viewScript: ['qds'] } })
    initWxsFilePathMap(tempDir)

    const loaded = loadWxsModule('miniprogram_npm_pkg_qds_util', tempDir, [])
    expect(loaded).toBeTruthy()
    expect(loaded.path).toBe('miniprogram_npm_pkg_qds_util')
    expect(loaded.code).toContain('brand')
  })

  it('加载不在 wxs/ 目录、模块 id 不含 _wxs_ 的 .wxs 依赖（潜伏 bug 修复）', () => {
    storeInfo(tempDir)
    initWxsFilePathMap(tempDir)

    const loaded = loadWxsModule('miniprogram_npm_pkg_helper', tempDir, [])
    expect(loaded).toBeTruthy()
    expect(loaded.code).toContain('help')
  })

  it('未扫描到的模块 id 返回 null', () => {
    storeInfo(tempDir, { fileTypes: { viewScript: ['qds'] } })
    initWxsFilePathMap(tempDir)

    expect(loadWxsModule('miniprogram_npm_pkg_does_not_exist', tempDir, [])).toBeNull()
  })
})
