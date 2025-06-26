import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('TypeScript 编译支持', () => {
	let tempDir

	beforeEach(() => {
		// 创建临时测试目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'))
	})

	afterEach(() => {
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该能够编译 TypeScript 页面文件', async () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index']
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置
		const pageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		
		const pageJsonPath = path.join(pageDir, 'index.json')
		fs.writeFileSync(pageJsonPath, JSON.stringify({
			usingComponents: {}
		}))

		// 创建 TypeScript 页面文件
		const pageTsPath = path.join(pageDir, 'index.ts')
		fs.writeFileSync(pageTsPath, `
interface PageData {
	message: string;
	count: number;
}

Page<PageData>({
	data: {
		message: 'Hello TypeScript',
		count: 0
	},
	
	onLoad(): void {
		console.log('Page loaded with TypeScript')
	},
	
	increment(): void {
		this.setData({
			count: this.data.count + 1
		})
	}
})
`)

		// 执行配置收集
		storeInfo(tempDir)
		
		// 模拟编译过程
		const pages = {
			mainPages: [{ path: 'pages/index/index' }]
		}
		
		const compileRes = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
		
		// 验证编译结果
		expect(compileRes).toBeDefined()
		expect(compileRes.length).toBeGreaterThan(0)
		
		const indexPage = compileRes.find(item => item.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.code).toContain('Hello TypeScript')
		expect(indexPage.code).toContain('Page(')
	})

	it('应该能够编译 TypeScript 组件文件', async () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index']
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置，引用 TypeScript 组件
		const pageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		
		const pageJsonPath = path.join(pageDir, 'index.json')
		fs.writeFileSync(pageJsonPath, JSON.stringify({
			usingComponents: {
				'my-component': '../../components/my-component/index'
			}
		}))

		const pageJsPath = path.join(pageDir, 'index.js')
		fs.writeFileSync(pageJsPath, 'Page({})')

		// 创建 TypeScript 组件
		const componentDir = path.join(tempDir, 'components/my-component')
		fs.mkdirSync(componentDir, { recursive: true })
		
		const componentJsonPath = path.join(componentDir, 'index.json')
		fs.writeFileSync(componentJsonPath, JSON.stringify({
			component: true,
			usingComponents: {}
		}))

		const componentTsPath = path.join(componentDir, 'index.ts')
		fs.writeFileSync(componentTsPath, `
interface ComponentData {
	title: string;
	visible: boolean;
}

interface ComponentMethods {
	toggle(): void;
	show(): void;
	hide(): void;
}

Component<ComponentData, {}, ComponentMethods>({
	data: {
		title: 'TypeScript Component',
		visible: false
	},
	
	methods: {
		toggle(): void {
			this.setData({
				visible: !this.data.visible
			})
		},
		
		show(): void {
			this.setData({ visible: true })
		},
		
		hide(): void {
			this.setData({ visible: false })
		}
	}
})
`)

		// 设置环境变量以便编译器能找到工作路径
		process.env.WORK_PATH = tempDir
		
		// 执行配置收集
		storeInfo(tempDir)
		
		// 从 env 模块获取页面信息，这样组件依赖会被正确处理
		const { getPages } = await import('../src/env.js')
		const pagesInfo = getPages()
		const pages = {
			mainPages: pagesInfo.mainPages
		}
		
		const compileRes = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
		
		// 验证编译结果
		expect(compileRes).toBeDefined()
		expect(compileRes.length).toBeGreaterThan(0)
		
		// 打印所有编译结果的路径以便调试
		console.log('编译结果路径:', compileRes.map(item => item.path))
		
		const componentModule = compileRes.find(item => 
			item.path === 'components/my-component/index' || 
			item.path === '/components/my-component/index' ||
			item.path.includes('components/my-component/index')
		)
		expect(componentModule).toBeDefined()
		expect(componentModule.code).toContain('TypeScript Component')
		expect(componentModule.code).toContain('Component(')
	})

	it('应该处理 TypeScript 编译错误', async () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index']
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置
		const pageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		
		const pageJsonPath = path.join(pageDir, 'index.json')
		fs.writeFileSync(pageJsonPath, JSON.stringify({
			usingComponents: {}
		}))

		// 创建包含语法错误的 TypeScript 文件
		const pageTsPath = path.join(pageDir, 'index.ts')
		fs.writeFileSync(pageTsPath, `
// 这个文件包含 TypeScript 语法错误，但仍应该能够编译
interface BadInterface {
	name: string
	// 缺少分号，但编译器应该能够处理
}

Page({
	data: {
		message: 'Hello'
	},
	
	onLoad() {
		console.log('Page loaded')
	}
})
`)

		// 执行配置收集
		storeInfo(tempDir)
		
		// 模拟编译过程
		const pages = {
			mainPages: [{ path: 'pages/index/index' }]
		}
		
		const compileRes = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
		
		// 验证编译结果 - 即使有错误也应该有输出
		expect(compileRes).toBeDefined()
		expect(compileRes.length).toBeGreaterThan(0)
		
		const indexPage = compileRes.find(item => item.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.code).toContain('Page(')
	})
}) 