import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('Import to Require Transformation', () => {
	let tempDir
	let originalCwd

	beforeEach(() => {
		originalCwd = process.cwd()
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-test-'))
		process.chdir(tempDir)
	})

	afterEach(() => {
		process.chdir(originalCwd)
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('should transform import statements to require statements', async () => {
		// 创建测试文件结构
		fs.mkdirSync('pages/index', { recursive: true })
		fs.mkdirSync('utils', { recursive: true })
		fs.mkdirSync('miniprogram_npm/@vant/weapp/toast', { recursive: true })
		
		// 创建 app.json
		fs.writeFileSync('app.json', JSON.stringify({
			pages: ['pages/index/index']
		}))
		
		// 创建工具模块
		fs.writeFileSync('utils/helper.js', `
			exports.formatDate = function(date) {
				return date.toISOString()
			}
		`)
		
		// 创建模拟的 vant 组件
		fs.writeFileSync('miniprogram_npm/@vant/weapp/toast/toast.js', `
			module.exports = {
				show: function(options) {
					console.log('Toast显示:', options)
				}
			}
		`)
		
		// 创建页面文件，使用 import 语句
		fs.writeFileSync('pages/index/index.js', `
			import { formatDate } from '../../utils/helper'
			import Toast from '@vant/weapp/toast/toast'
			
			Page({
				onLoad() {
					const now = formatDate(new Date())
					Toast.show({ message: now })
				}
			})
		`)
		
		fs.writeFileSync('pages/index/index.json', JSON.stringify({
			navigationBarTitleText: '首页'
		}))
		
		// 执行配置收集
		storeInfo(tempDir)
		
		// 模拟编译过程
		const pages = {
			mainPages: [{ path: 'pages/index/index' }]
		}
		
		const progress = { completedTasks: 0 }
		const result = await compileJS(pages.mainPages, null, null, progress)
		
		expect(result).toBeDefined()
		expect(result.length).toBeGreaterThan(0)
		
		// 获取页面模块的编译结果
		const pageModule = result.find(module => module.path === 'pages/index/index')
		expect(pageModule).toBeDefined()
		
		// 验证编译后的代码
		const compiledCode = pageModule.code
		
		// 验证 import 语句被转换为 require 语句
		expect(compiledCode).toContain('require(')
		expect(compiledCode).toContain('require("/utils/helper")')
		expect(compiledCode).toContain('require("/miniprogram_npm/@vant/weapp/toast/toast")')
		
		// 验证不再包含 import 语句
		expect(compiledCode).not.toContain('import ')
		expect(compiledCode).not.toContain('from ')
		
		// 验证变量声明正确（Babel 可能会重命名变量）
		expect(compiledCode).toContain('formatDate')
		expect(compiledCode).toContain('_toast') // Babel 重命名为 _toast
	})

	it('should handle different import patterns correctly', async () => {
		// 创建测试文件结构
		fs.mkdirSync('pages/test', { recursive: true })
		fs.mkdirSync('utils', { recursive: true })
		
		// 创建 app.json
		fs.writeFileSync('app.json', JSON.stringify({
			pages: ['pages/test/test']
		}))
		
		// 创建工具模块
		fs.writeFileSync('utils/api.js', `
			exports.request = function() { return Promise.resolve({}) }
			exports.upload = function() { return Promise.resolve({}) }
		`)
		
		// 创建页面文件，使用不同的 import 模式
		fs.writeFileSync('pages/test/test.js', `
			// 命名导入
			import { request, upload } from '../../utils/api'
			
			// 默认导入
			import * as api from '../../utils/api'
			
			// 混合导入
			import defaultExport, { namedExport } from '../../utils/api'
			
			Page({
				onLoad() {
					request()
					upload()
					api.request()
				}
			})
		`)
		
		fs.writeFileSync('pages/test/test.json', JSON.stringify({
			navigationBarTitleText: '测试页'
		}))
		
		// 执行配置收集
		storeInfo(tempDir)
		
		// 模拟编译过程
		const pages = {
			mainPages: [{ path: 'pages/test/test' }]
		}
		
		const progress = { completedTasks: 0 }
		const result = await compileJS(pages.mainPages, null, null, progress)
		
		expect(result).toBeDefined()
		expect(result.length).toBeGreaterThan(0)
		
		// 获取页面模块的编译结果
		const pageModule = result.find(module => module.path === 'pages/test/test')
		expect(pageModule).toBeDefined()
		
		// 验证编译后的代码
		const compiledCode = pageModule.code
		
		// 验证所有 import 语句都被转换为 require 语句
		expect(compiledCode).toContain('require(')
		expect(compiledCode).toContain('require("/utils/api")')
		
		// 验证不再包含 import 语句
		expect(compiledCode).not.toContain('import ')
		expect(compiledCode).not.toContain('from ')
		
		// 验证变量声明正确
		expect(compiledCode).toContain('request')
		expect(compiledCode).toContain('upload')
		expect(compiledCode).toContain('api')
	})
}) 