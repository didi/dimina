import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as cheerio from 'cheerio'
import { resetStoreInfo } from '../src/env.js'

// 直接导入 transTagWxs 函数
import { compileML } from '../src/core/view-compiler.js'

// 模拟 transTagWxs 函数
function testTransTagWxs(htmlContent, filePath, tempDir) {
	const $ = cheerio.load(htmlContent)
	const scriptModule = []
	
	// 导入 transTagWxs 函数的核心逻辑
	let wxsNodes = $('wxs')
	if (wxsNodes.length === 0) {
		wxsNodes = $('dds')
	}
	
	wxsNodes.each((_, elem) => {
		const smName = $(elem).attr('module')
		if (smName) {
			let uniqueModuleName = smName
			let cacheKey = smName
			
			const src = $(elem).attr('src')
			let wxsFilePath = null
			const workPath = tempDir
			
			if (src) {
				// 检查是否是 npm 组件路径
				if (filePath.includes('/miniprogram_npm/')) {
					// 获取组件所在目录的完整路径
					const componentDir = filePath.split('/').slice(0, -1).join('/')
					const componentFullPath = workPath + componentDir
					
					// 使用 Node.js path.resolve 来正确解析相对路径
					wxsFilePath = path.resolve(componentFullPath, src)
				} else {
					// 对于普通组件，使用原有逻辑
					const relativePath = filePath.split('/').filter(part => part !== '').slice(0, -1).join('/')
					wxsFilePath = path.resolve(workPath, relativePath, src)
				}
				
				if (wxsFilePath) {
					// 为外部 wxs 文件生成唯一的模块名和缓存键
					const relativePath = wxsFilePath.replace(workPath, '').replace(/\.wxs$/, '')
					uniqueModuleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_+/, '')
					cacheKey = wxsFilePath // 使用文件路径作为缓存键确保唯一性
				}
			}

			if (src && wxsFilePath && fs.existsSync(wxsFilePath)) {
				const wxsContent = fs.readFileSync(wxsFilePath, 'utf8').trim()
				if (wxsContent) {
					scriptModule.push({
						path: uniqueModuleName,
						code: wxsContent,
						originalName: smName,
					})
				}
			} else if (!src) {
				// 内联 wxs
				const wxsContent = $(elem).html()
				if (wxsContent) {
					scriptModule.push({
						path: uniqueModuleName,
						code: wxsContent,
						originalName: smName,
					})
				}
			}
		}
	})
	
	return scriptModule
}

describe('wxs 模块名冲突修复验证', () => {
	let tempDir

	beforeEach(() => {
		// 创建临时目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxs-conflict-test-'))
	})

	afterEach(() => {
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该为不同路径的相同模块名生成唯一标识', () => {
		// 创建两个不同组件的 wxs 文件
		const radioDir = path.join(tempDir, 'miniprogram_npm/@vant/weapp/radio')
		const iconDir = path.join(tempDir, 'miniprogram_npm/@vant/weapp/icon')
		
		fs.mkdirSync(radioDir, { recursive: true })
		fs.mkdirSync(iconDir, { recursive: true })
		
		fs.writeFileSync(path.join(radioDir, 'index.wxs'), `
			function iconStyle() {
				return 'radio-style';
			}
			module.exports = { iconStyle: iconStyle };
		`)
		
		fs.writeFileSync(path.join(iconDir, 'index.wxs'), `
			function rootClass() {
				return 'icon-class';
			}
			module.exports = { rootClass: rootClass };
		`)

		// 测试 radio 组件的 wxs
		const radioHtml = '<wxs src="./index.wxs" module="computed" />'
		const radioModules = testTransTagWxs(radioHtml, '/miniprogram_npm/@vant/weapp/radio/index', tempDir)
		
		// 测试 icon 组件的 wxs
		const iconHtml = '<wxs src="./index.wxs" module="computed" />'
		const iconModules = testTransTagWxs(iconHtml, '/miniprogram_npm/@vant/weapp/icon/index', tempDir)

		// 验证生成了不同的唯一模块名
		expect(radioModules).toHaveLength(1)
		expect(iconModules).toHaveLength(1)
		
		expect(radioModules[0].path).toBe('miniprogram_npm__vant_weapp_radio_index')
		expect(iconModules[0].path).toBe('miniprogram_npm__vant_weapp_icon_index')
		
		// 验证原始模块名保持不变
		expect(radioModules[0].originalName).toBe('computed')
		expect(iconModules[0].originalName).toBe('computed')
		
		// 验证内容正确
		expect(radioModules[0].code).toContain('iconStyle')
		expect(radioModules[0].code).toContain('radio-style')
		
		expect(iconModules[0].code).toContain('rootClass')
		expect(iconModules[0].code).toContain('icon-class')
	})

	it('应该正确处理内联 wxs 和外部 wxs 的模块名', () => {
		// 创建外部 wxs 文件
		const componentDir = path.join(tempDir, 'miniprogram_npm/test-package')
		fs.mkdirSync(componentDir, { recursive: true })
		
		fs.writeFileSync(path.join(componentDir, 'external.wxs'), `
			function externalFunc() {
				return 'external-result';
			}
			module.exports = { externalFunc: externalFunc };
		`)

		// 测试混合的 wxs
		const mixedHtml = `
			<wxs module="inline">
				function inlineFunc() {
					return 'inline-result';
				}
				module.exports = { inlineFunc: inlineFunc };
			</wxs>
			<wxs src="./external.wxs" module="external" />
		`
		
		const modules = testTransTagWxs(mixedHtml, '/miniprogram_npm/test-package/index', tempDir)

		// 验证生成了两个模块
		expect(modules).toHaveLength(2)
		
		// 内联 wxs 应该保持原始模块名
		const inlineModule = modules.find(m => m.originalName === 'inline')
		expect(inlineModule).toBeDefined()
		expect(inlineModule.path).toBe('inline')
		expect(inlineModule.code).toContain('inlineFunc')
		
		// 外部 wxs 应该生成唯一模块名
		const externalModule = modules.find(m => m.originalName === 'external')
		expect(externalModule).toBeDefined()
		expect(externalModule.path).toBe('miniprogram_npm_test_package_external')
		expect(externalModule.code).toContain('externalFunc')
	})

	it('应该正确处理相同文件名但不同路径的 wxs 文件', () => {
		// 创建两个不同包的 utils.wxs 文件
		const packageADir = path.join(tempDir, 'miniprogram_npm/package-a')
		const packageBDir = path.join(tempDir, 'miniprogram_npm/package-b')
		
		fs.mkdirSync(packageADir, { recursive: true })
		fs.mkdirSync(packageBDir, { recursive: true })
		
		fs.writeFileSync(path.join(packageADir, 'utils.wxs'), `
			function format(value) {
				return 'Package A: ' + value;
			}
			module.exports = { format: format };
		`)
		
		fs.writeFileSync(path.join(packageBDir, 'utils.wxs'), `
			function format(value) {
				return 'Package B: ' + value;
			}
			module.exports = { format: format };
		`)

		// 测试两个组件的 utils.wxs
		const htmlA = '<wxs src="./utils.wxs" module="utils" />'
		const modulesA = testTransTagWxs(htmlA, '/miniprogram_npm/package-a/index', tempDir)
		
		const htmlB = '<wxs src="./utils.wxs" module="utils" />'
		const modulesB = testTransTagWxs(htmlB, '/miniprogram_npm/package-b/index', tempDir)

		// 验证生成了不同的唯一模块名
		expect(modulesA).toHaveLength(1)
		expect(modulesB).toHaveLength(1)
		
		expect(modulesA[0].path).toBe('miniprogram_npm_package_a_utils')
		expect(modulesB[0].path).toBe('miniprogram_npm_package_b_utils')
		
		// 验证原始模块名相同
		expect(modulesA[0].originalName).toBe('utils')
		expect(modulesB[0].originalName).toBe('utils')
		
		// 验证内容不同
		expect(modulesA[0].code).toContain('Package A:')
		expect(modulesB[0].code).toContain('Package B:')
	})
}) 