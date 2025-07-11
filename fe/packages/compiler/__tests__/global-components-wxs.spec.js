import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('全局组件 wxs 问题修复', () => {
	let tempDir
	let originalWorkPath
	let originalTargetPath

	beforeEach(() => {
		// 保存原始环境变量
		originalWorkPath = process.env.WORK_PATH
		originalTargetPath = process.env.TARGET_PATH
		
		// 创建临时测试目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'global-wxs-test-'))
	})

	afterEach(() => {
		// 恢复原始环境变量
		if (originalWorkPath) {
			process.env.WORK_PATH = originalWorkPath
		} else {
			delete process.env.WORK_PATH
		}
		
		if (originalTargetPath) {
			process.env.TARGET_PATH = originalTargetPath
		} else {
			delete process.env.TARGET_PATH
		}
		
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该在所有使用全局组件的页面中包含 wxs 代码', async () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index', 'pages/about/about'],
			usingComponents: {
				'global-component': './components/global-component/index'
			}
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置
		const indexPageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(indexPageDir, { recursive: true })
		
		const indexPageJsonPath = path.join(indexPageDir, 'index.json')
		fs.writeFileSync(indexPageJsonPath, JSON.stringify({
			navigationBarTitleText: '首页'
		}))

		const indexPageWxmlPath = path.join(indexPageDir, 'index.wxml')
		fs.writeFileSync(indexPageWxmlPath, `
<view>
	<global-component />
</view>
		`)

		const aboutPageDir = path.join(tempDir, 'pages/about')
		fs.mkdirSync(aboutPageDir, { recursive: true })
		
		const aboutPageJsonPath = path.join(aboutPageDir, 'about.json')
		fs.writeFileSync(aboutPageJsonPath, JSON.stringify({
			navigationBarTitleText: '关于'
		}))

		const aboutPageWxmlPath = path.join(aboutPageDir, 'about.wxml')
		fs.writeFileSync(aboutPageWxmlPath, `
<view>
	<global-component />
</view>
		`)

		// 创建全局组件
		const globalComponentDir = path.join(tempDir, 'components/global-component')
		fs.mkdirSync(globalComponentDir, { recursive: true })
		
		const globalComponentJsonPath = path.join(globalComponentDir, 'index.json')
		fs.writeFileSync(globalComponentJsonPath, JSON.stringify({
			component: true
		}))

		const globalComponentWxmlPath = path.join(globalComponentDir, 'index.wxml')
		fs.writeFileSync(globalComponentWxmlPath, `
<wxs module="utils">
	function formatText(text) {
		return text + ' from wxs'
	}
	module.exports = {
		formatText: formatText
	}
</wxs>
<view>
	<text>{{utils.formatText('Hello')}}</text>
</view>
		`)

		// 设置环境变量
		process.env.WORK_PATH = tempDir
		
		// 创建输出目录
		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir
		
		// 清理模块缓存
		const envModulePath = path.resolve(__dirname, '../src/env.js')
		delete require.cache[envModulePath]
		
		// 重新导入并初始化环境
		const { storeInfo, getPages, getTargetPath } = await import('../src/env.js')
		
		// 执行配置收集
		storeInfo(tempDir)
		
		// 获取页面信息
		const pagesInfo = getPages()

		// 验证全局组件被正确合并到页面配置中
		expect(pagesInfo.mainPages).toHaveLength(2)
		expect(pagesInfo.mainPages[0].usingComponents).toHaveProperty('global-component')
		expect(pagesInfo.mainPages[1].usingComponents).toHaveProperty('global-component')

		// 模拟编译过程
		const { compileML } = await import('../src/core/view-compiler.js')
		
		// 编译页面
		const progress = { completedTasks: 0 }
		await compileML(pagesInfo.mainPages, null, progress)

		// 验证编译结果
		const mainDir = path.join(outputDir, 'main')
		expect(fs.existsSync(mainDir)).toBe(true)

		const indexOutputPath = path.join(mainDir, 'pages_index_index.js')
		const aboutOutputPath = path.join(mainDir, 'pages_about_about.js')

		expect(fs.existsSync(indexOutputPath)).toBe(true)
		expect(fs.existsSync(aboutOutputPath)).toBe(true)

		// 读取编译后的文件内容
		const indexContent = fs.readFileSync(indexOutputPath, 'utf-8')
		const aboutContent = fs.readFileSync(aboutOutputPath, 'utf-8')

		// 验证两个页面都包含 wxs 代码的核心功能
		expect(indexContent).toContain('formatText')
		expect(aboutContent).toContain('formatText')
		
		// 验证两个页面都包含 utils 模块定义
		expect(indexContent).toContain('"utils"')
		expect(aboutContent).toContain('"utils"')
		
		// 验证两个页面都包含 wxs 模块的完整定义
		expect(indexContent).toContain('from wxs')
		expect(aboutContent).toContain('from wxs')
		
		// 验证两个页面都包含压缩后的 exports（可能是 t.exports 或 module.exports）
		expect(indexContent).toMatch(/[t|module]\.exports/)
		expect(aboutContent).toMatch(/[t|module]\.exports/)
		
		// 验证两个页面都包含全局组件的模块定义
		expect(indexContent).toContain('/components/global-component/index')
		expect(aboutContent).toContain('/components/global-component/index')

		console.log('✅ 全局组件 wxs 问题修复验证通过')
		console.log('首页文件大小:', indexContent.length, '字节')
		console.log('关于页面文件大小:', aboutContent.length, '字节')
		
		// 验证两个页面的内容长度相似（都包含了相同的 wxs 代码）
		const sizeDifference = Math.abs(indexContent.length - aboutContent.length)
		expect(sizeDifference).toBeLessThan(100) // 允许一些小的差异
	})
}) 