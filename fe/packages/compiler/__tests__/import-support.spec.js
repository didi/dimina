import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('Import Statement Support', () => {
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

	it('should handle relative import statements', async () => {
		// 创建测试文件结构
		fs.mkdirSync('pages/index', { recursive: true })
		fs.mkdirSync('utils', { recursive: true })
		
		// 创建 app.json
		fs.writeFileSync('app.json', JSON.stringify({
			pages: ['pages/index/index']
		}))
		
		// 创建工具模块
		fs.writeFileSync('utils/helper.js', `
			export function formatDate(date) {
				return date.toISOString()
			}
		`)
		
		// 创建页面文件，使用 import 语句
		fs.writeFileSync('pages/index/index.js', `
			import { formatDate } from '../../utils/helper'
			
			Page({
				onLoad() {
					console.log('页面加载')
					const now = formatDate(new Date())
					console.log('当前时间:', now)
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
		
		// 检查是否包含了依赖的模块
		const modulePaths = result.map(module => module.path)
		expect(modulePaths).toContain('pages/index/index')
		expect(modulePaths).toContain('/utils/helper')
	})

	it('should handle npm package import statements', async () => {
		// 创建测试文件结构
		fs.mkdirSync('pages/index', { recursive: true })
		fs.mkdirSync('miniprogram_npm/@vant/weapp/toast', { recursive: true })
		
		// 创建 app.json
		fs.writeFileSync('app.json', JSON.stringify({
			pages: ['pages/index/index']
		}))
		
		// 创建模拟的 vant 组件
		fs.writeFileSync('miniprogram_npm/@vant/weapp/toast/toast.js', `
			export default {
				show: function(options) {
					console.log('Toast显示:', options)
				}
			}
		`)
		
		// 创建页面文件，使用 npm 包 import 语句
		fs.writeFileSync('pages/index/index.js', `
			import Toast from '@vant/weapp/toast/toast'
			
			Page({
				onLoad() {
					console.log('页面加载')
					Toast.show({
						message: '欢迎使用'
					})
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
		
		// 检查是否包含了依赖的模块
		const modulePaths = result.map(module => module.path)
		expect(modulePaths).toContain('pages/index/index')
		expect(modulePaths).toContain('/miniprogram_npm/@vant/weapp/toast/toast')
	})

	it('should handle mixed import statements', async () => {
		// 创建测试文件结构
		fs.mkdirSync('pages/index', { recursive: true })
		fs.mkdirSync('utils', { recursive: true })
		fs.mkdirSync('miniprogram_npm/@vant/weapp/dialog', { recursive: true })
		
		// 创建 app.json
		fs.writeFileSync('app.json', JSON.stringify({
			pages: ['pages/index/index']
		}))
		
		// 创建工具模块
		fs.writeFileSync('utils/api.js', `
			export function request(url, data) {
				return new Promise((resolve) => {
					setTimeout(() => resolve({ data: 'success' }), 100)
				})
			}
		`)
		
		// 创建模拟的 vant 组件
		fs.writeFileSync('miniprogram_npm/@vant/weapp/dialog/dialog.js', `
			export default {
				confirm: function(options) {
					console.log('Dialog确认:', options)
					return Promise.resolve(true)
				}
			}
		`)
		
		// 创建页面文件，混合使用不同类型的 import 语句
		fs.writeFileSync('pages/index/index.js', `
			import { request } from '../../utils/api'
			import Dialog from '@vant/weapp/dialog/dialog'
			
			Page({
				async onLoad() {
					console.log('页面加载')
					
					const result = await request('/api/data', {})
					console.log('请求结果:', result)
					
					const confirmed = await Dialog.confirm({
						title: '提示',
						message: '确认操作吗？'
					})
					
					if (confirmed) {
						console.log('用户确认')
					}
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
		
		// 检查是否包含了所有依赖的模块
		const modulePaths = result.map(module => module.path)
		expect(modulePaths).toContain('pages/index/index')
		expect(modulePaths).toContain('/utils/api')
		expect(modulePaths).toContain('/miniprogram_npm/@vant/weapp/dialog/dialog')
		
		// 验证编译后的代码包含正确的模块路径
		const indexModule = result.find(module => module.path === 'pages/index/index')
		expect(indexModule).toBeDefined()
		expect(indexModule.code).toContain('/utils/api')
		expect(indexModule.code).toContain('/miniprogram_npm/@vant/weapp/dialog/dialog')
	})
}) 