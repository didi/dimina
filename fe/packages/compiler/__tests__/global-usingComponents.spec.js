import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { storeInfo, getPages } from '../src/env.js'

describe('全局 usingComponents 支持', () => {
	let tempDir

	beforeEach(() => {
		// 创建临时测试目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'global-components-test-'))
	})

	afterEach(() => {
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该能够处理 app.json 中的全局 usingComponents', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index', 'pages/about/about'],
			usingComponents: {
				'global-button': './components/global-button/index',
				'global-header': './components/global-header/index'
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

		const aboutPageDir = path.join(tempDir, 'pages/about')
		fs.mkdirSync(aboutPageDir, { recursive: true })
		
		const aboutPageJsonPath = path.join(aboutPageDir, 'about.json')
		fs.writeFileSync(aboutPageJsonPath, JSON.stringify({
			navigationBarTitleText: '关于'
		}))

		// 创建全局组件
		const globalButtonDir = path.join(tempDir, 'components/global-button')
		fs.mkdirSync(globalButtonDir, { recursive: true })
		
		const globalButtonJsonPath = path.join(globalButtonDir, 'index.json')
		fs.writeFileSync(globalButtonJsonPath, JSON.stringify({
			component: true
		}))

		const globalHeaderDir = path.join(tempDir, 'components/global-header')
		fs.mkdirSync(globalHeaderDir, { recursive: true })
		
		const globalHeaderJsonPath = path.join(globalHeaderDir, 'index.json')
		fs.writeFileSync(globalHeaderJsonPath, JSON.stringify({
			component: true
		}))

		// 执行配置收集
		storeInfo(tempDir)
		const pages = getPages()

		// 验证主页面都包含全局组件
		expect(pages.mainPages).toBeDefined()
		expect(pages.mainPages.length).toBe(2)

		const indexPage = pages.mainPages.find(p => p.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.usingComponents).toBeDefined()
		expect(indexPage.usingComponents['global-button']).toBe('/components/global-button/index')
		expect(indexPage.usingComponents['global-header']).toBe('/components/global-header/index')

		const aboutPage = pages.mainPages.find(p => p.path === 'pages/about/about')
		expect(aboutPage).toBeDefined()
		expect(aboutPage.usingComponents).toBeDefined()
		expect(aboutPage.usingComponents['global-button']).toBe('/components/global-button/index')
		expect(aboutPage.usingComponents['global-header']).toBe('/components/global-header/index')
	})

	it('应该支持页面级组件覆盖全局组件', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index'],
			usingComponents: {
				'my-button': './components/global-button/index'
			}
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置，使用不同的组件覆盖全局组件
		const indexPageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(indexPageDir, { recursive: true })
		
		const indexPageJsonPath = path.join(indexPageDir, 'index.json')
		fs.writeFileSync(indexPageJsonPath, JSON.stringify({
			navigationBarTitleText: '首页',
			usingComponents: {
				'my-button': './components/page-button/index'
			}
		}))

		// 创建全局组件
		const globalButtonDir = path.join(tempDir, 'components/global-button')
		fs.mkdirSync(globalButtonDir, { recursive: true })
		
		const globalButtonJsonPath = path.join(globalButtonDir, 'index.json')
		fs.writeFileSync(globalButtonJsonPath, JSON.stringify({
			component: true
		}))

		// 创建页面级组件
		const pageButtonDir = path.join(tempDir, 'components/page-button')
		fs.mkdirSync(pageButtonDir, { recursive: true })
		
		const pageButtonJsonPath = path.join(pageButtonDir, 'index.json')
		fs.writeFileSync(pageButtonJsonPath, JSON.stringify({
			component: true
		}))

		// 执行配置收集
		storeInfo(tempDir)
		const pages = getPages()

		// 验证页面级组件覆盖了全局组件
		const indexPage = pages.mainPages.find(p => p.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.usingComponents).toBeDefined()
		expect(indexPage.usingComponents['my-button']).toBe('/pages/index/components/page-button/index')
	})

	it('应该支持分包页面继承全局组件', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index'],
			subPackages: [{
				root: 'packageA',
				pages: ['pages/detail/detail']
			}],
			usingComponents: {
				'global-button': './components/global-button/index'
			}
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建主包页面配置
		const indexPageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(indexPageDir, { recursive: true })
		
		const indexPageJsonPath = path.join(indexPageDir, 'index.json')
		fs.writeFileSync(indexPageJsonPath, JSON.stringify({
			navigationBarTitleText: '首页'
		}))

		// 创建分包页面配置
		const detailPageDir = path.join(tempDir, 'packageA/pages/detail')
		fs.mkdirSync(detailPageDir, { recursive: true })
		
		const detailPageJsonPath = path.join(detailPageDir, 'detail.json')
		fs.writeFileSync(detailPageJsonPath, JSON.stringify({
			navigationBarTitleText: '详情'
		}))

		// 创建全局组件
		const globalButtonDir = path.join(tempDir, 'components/global-button')
		fs.mkdirSync(globalButtonDir, { recursive: true })
		
		const globalButtonJsonPath = path.join(globalButtonDir, 'index.json')
		fs.writeFileSync(globalButtonJsonPath, JSON.stringify({
			component: true
		}))

		// 执行配置收集
		storeInfo(tempDir)
		const pages = getPages()

		// 验证主包页面包含全局组件
		const indexPage = pages.mainPages.find(p => p.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.usingComponents).toBeDefined()
		expect(indexPage.usingComponents['global-button']).toBe('/components/global-button/index')

		// 验证分包页面也包含全局组件
		expect(pages.subPages).toBeDefined()
		expect(pages.subPages['sub_packageA']).toBeDefined()
		expect(pages.subPages['sub_packageA'].info).toBeDefined()
		expect(pages.subPages['sub_packageA'].info.length).toBe(1)

		const detailPage = pages.subPages['sub_packageA'].info[0]
		expect(detailPage).toBeDefined()
		expect(detailPage.path).toBe('packageA/pages/detail/detail')
		expect(detailPage.usingComponents).toBeDefined()
		expect(detailPage.usingComponents['global-button']).toBe('/components/global-button/index')
	})

	it('应该支持全局组件中的 npm 组件', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index'],
			usingComponents: {
				'vant-button': 'vant-weapp/button',
				'local-button': './components/local-button/index'
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

		// 创建本地组件
		const localButtonDir = path.join(tempDir, 'components/local-button')
		fs.mkdirSync(localButtonDir, { recursive: true })
		
		const localButtonJsonPath = path.join(localButtonDir, 'index.json')
		fs.writeFileSync(localButtonJsonPath, JSON.stringify({
			component: true
		}))

		// 创建 npm 组件（模拟）
		const npmButtonDir = path.join(tempDir, 'miniprogram_npm/vant-weapp/button')
		fs.mkdirSync(npmButtonDir, { recursive: true })
		
		const npmButtonJsonPath = path.join(npmButtonDir, 'index.json')
		fs.writeFileSync(npmButtonJsonPath, JSON.stringify({
			component: true
		}))

		// 执行配置收集
		storeInfo(tempDir)
		const pages = getPages()

		// 验证页面包含所有全局组件
		const indexPage = pages.mainPages.find(p => p.path === 'pages/index/index')
		expect(indexPage).toBeDefined()
		expect(indexPage.usingComponents).toBeDefined()
		expect(indexPage.usingComponents['vant-button']).toBe('/miniprogram_npm/vant-weapp/button')
		expect(indexPage.usingComponents['local-button']).toBe('/components/local-button/index')
	})
}) 