import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 模拟 transTagWxs 函数的核心逻辑
function mockTransTagWxs(componentPath, wxsSrc, workPath) {
	let wxsFilePath
	
	// 检查是否是 npm 组件路径
	if (componentPath.includes('/miniprogram_npm/')) {
		// 对于 npm 组件，需要特殊处理相对路径
		// componentPath 格式: /miniprogram_npm/@vant/weapp/radio-group/index
		// wxsSrc 格式: ../wxs/utils.wxs 或 ./index.wxs
		
		// 获取组件所在目录的完整路径
		const componentDir = componentPath.split('/').slice(0, -1).join('/')
		const componentFullPath = workPath + componentDir
		
		// 使用 Node.js path.resolve 来正确解析相对路径
		wxsFilePath = path.resolve(componentFullPath, wxsSrc)
	} else {
		// 对于普通组件，使用简化的逻辑
		const relativePath = componentPath.split('/').filter(part => part !== '').slice(0, -1).join('/')
		wxsFilePath = path.resolve(workPath, relativePath, wxsSrc)
	}
	
	return wxsFilePath
}

describe('npm 组件 wxs 路径处理', () => {
	let tempDir
	let workPath

	beforeEach(() => {
		// 创建临时目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-test-'))
		workPath = tempDir
		
		// 创建 npm 组件目录结构
		const npmComponentDir = path.join(tempDir, 'miniprogram_npm/@vant/weapp')
		fs.mkdirSync(npmComponentDir, { recursive: true })
		
		// 创建 wxs 目录和文件
		const wxsDir = path.join(npmComponentDir, 'wxs')
		fs.mkdirSync(wxsDir, { recursive: true })
		fs.writeFileSync(path.join(wxsDir, 'utils.wxs'), 'module.exports = { bem: function() {} }')
		
		// 创建组件目录和文件
		const radioDir = path.join(npmComponentDir, 'radio')
		fs.mkdirSync(radioDir, { recursive: true })
		fs.writeFileSync(path.join(radioDir, 'index.wxs'), 'module.exports = { computed: function() {} }')
		
		const radioGroupDir = path.join(npmComponentDir, 'radio-group')
		fs.mkdirSync(radioGroupDir, { recursive: true })
		fs.writeFileSync(path.join(radioGroupDir, 'index.wxs'), 'module.exports = { computed: function() {} }')
	})

	afterEach(() => {
		// 清理临时目录
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('应该正确解析 npm 组件中的相对路径 wxs 文件 - 上级目录', () => {
		const componentPath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsSrc = '../wxs/utils.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/utils.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})

	it('应该正确解析 npm 组件中的相对路径 wxs 文件 - 当前目录', () => {
		const componentPath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsSrc = './index.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/radio/index.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})

	it('应该正确解析 npm 组件中的复杂相对路径 wxs 文件', () => {
		const componentPath = '/miniprogram_npm/@vant/weapp/radio-group/index'
		const wxsSrc = '../wxs/utils.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/utils.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})

	it('应该正确处理非 npm 组件的路径', () => {
		// 创建普通组件目录
		const normalComponentDir = path.join(workPath, 'components/custom')
		fs.mkdirSync(normalComponentDir, { recursive: true })
		fs.writeFileSync(path.join(normalComponentDir, 'utils.wxs'), 'module.exports = {}')
		
		const componentPath = '/components/custom/index'
		const wxsSrc = './utils.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'components/custom/utils.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})

	it('应该正确处理带有作用域的 npm 包路径', () => {
		// 创建另一个作用域包
		const scopedPackageDir = path.join(workPath, 'miniprogram_npm/@other/package/component')
		fs.mkdirSync(scopedPackageDir, { recursive: true })
		
		const utilsDir = path.join(workPath, 'miniprogram_npm/@other/package/utils')
		fs.mkdirSync(utilsDir, { recursive: true })
		fs.writeFileSync(path.join(utilsDir, 'helper.wxs'), 'module.exports = {}')
		
		const componentPath = '/miniprogram_npm/@other/package/component/index'
		const wxsSrc = '../utils/helper.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'miniprogram_npm/@other/package/utils/helper.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})

	it('应该正确处理深层嵌套的相对路径', () => {
		// 创建深层嵌套结构
		const deepComponentDir = path.join(workPath, 'miniprogram_npm/@vant/weapp/calendar/components/month')
		fs.mkdirSync(deepComponentDir, { recursive: true })
		
		const componentPath = '/miniprogram_npm/@vant/weapp/calendar/components/month/index'
		const wxsSrc = '../../../wxs/utils.wxs'
		
		const resolvedPath = mockTransTagWxs(componentPath, wxsSrc, workPath)
		const expectedPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/utils.wxs')
		
		expect(resolvedPath).toBe(expectedPath)
		expect(fs.existsSync(resolvedPath)).toBe(true)
	})
}) 