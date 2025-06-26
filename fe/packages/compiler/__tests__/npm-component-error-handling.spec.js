import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { storeInfo, getComponent } from '../src/env.js'

describe('npm 组件错误处理', () => {
	let tempDir

	beforeEach(() => {
		// 创建临时测试目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-error-test-'))
	})

	afterEach(() => {
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该为缺失配置文件的 npm 组件创建默认配置', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index']
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置，引用一个 npm 组件
		const pageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		
		const pageJsonPath = path.join(pageDir, 'index.json')
		fs.writeFileSync(pageJsonPath, JSON.stringify({
			usingComponents: {
				'vant-button': '@vant/weapp/button'
			}
		}))

		// 创建 miniprogram_npm 目录但不包含配置文件
		const npmDir = path.join(tempDir, 'miniprogram_npm/@vant/weapp/button')
		fs.mkdirSync(npmDir, { recursive: true })
		
		// 只创建 JS 文件，不创建 JSON 配置文件
		fs.writeFileSync(path.join(npmDir, 'index.js'), 'Component({})')

		// 执行配置收集
		storeInfo(tempDir)

		// 验证 npm 组件是否被正确处理
		const component = getComponent('/miniprogram_npm/@vant/weapp/button')
		expect(component).toBeDefined()
		expect(component.component).toBe(true)
		expect(component.path).toBe('/miniprogram_npm/@vant/weapp/button')
	})

	it('应该正确处理有 index.json 的 npm 组件', () => {
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
			usingComponents: {
				'my-component': 'my-npm-package'
			}
		}))

		// 创建 npm 组件，在 index 子目录中
		const npmIndexDir = path.join(tempDir, 'miniprogram_npm/my-npm-package/index')
		fs.mkdirSync(npmIndexDir, { recursive: true })
		
		fs.writeFileSync(path.join(npmIndexDir, 'index.json'), JSON.stringify({
			component: true,
			usingComponents: {}
		}))
		fs.writeFileSync(path.join(npmIndexDir, 'index.js'), 'Component({})')

		// 执行配置收集
		storeInfo(tempDir)

		// 验证 npm 组件是否被正确处理
		// npm 解析器可能返回 /miniprogram_npm/my-npm-package/index
		let component = getComponent('/miniprogram_npm/my-npm-package')
		if (!component) {
			component = getComponent('/miniprogram_npm/my-npm-package/index')
		}
		expect(component).toBeDefined()
		expect(component.component).toBe(true)
	})

	it('应该跳过不存在的非 npm 组件', () => {
		// 创建基本的项目结构
		const appJsonPath = path.join(tempDir, 'app.json')
		fs.writeFileSync(appJsonPath, JSON.stringify({
			pages: ['pages/index/index']
		}))

		const projectConfigPath = path.join(tempDir, 'project.config.json')
		fs.writeFileSync(projectConfigPath, JSON.stringify({
			appid: 'test-app-id'
		}))

		// 创建页面配置，引用一个不存在的本地组件
		const pageDir = path.join(tempDir, 'pages/index')
		fs.mkdirSync(pageDir, { recursive: true })
		
		const pageJsonPath = path.join(pageDir, 'index.json')
		fs.writeFileSync(pageJsonPath, JSON.stringify({
			usingComponents: {
				'local-component': './components/non-existent'
			}
		}))

		// 执行配置收集
		storeInfo(tempDir)

		// 验证不存在的组件没有被添加
		const component = getComponent('/pages/index/components/non-existent')
		expect(component).toBeUndefined()
	})

	it('应该处理 npm 组件的嵌套依赖', () => {
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
			usingComponents: {
				'parent-component': 'parent-package'
			}
		}))

		// 创建父组件
		const parentDir = path.join(tempDir, 'miniprogram_npm/parent-package')
		fs.mkdirSync(parentDir, { recursive: true })
		
		fs.writeFileSync(path.join(parentDir, 'index.json'), JSON.stringify({
			component: true,
			usingComponents: {
				'child-component': 'child-package'
			}
		}))
		fs.writeFileSync(path.join(parentDir, 'index.js'), 'Component({})')

		// 创建子组件（没有配置文件，应该使用默认配置）
		const childDir = path.join(tempDir, 'miniprogram_npm/child-package')
		fs.mkdirSync(childDir, { recursive: true })
		fs.writeFileSync(path.join(childDir, 'index.js'), 'Component({})')

		// 执行配置收集
		storeInfo(tempDir)

		// 验证父组件和子组件都被正确处理
		const parentComponent = getComponent('/miniprogram_npm/parent-package')
		expect(parentComponent).toBeDefined()
		expect(parentComponent.component).toBe(true)

		const childComponent = getComponent('/miniprogram_npm/child-package')
		expect(childComponent).toBeDefined()
		expect(childComponent.component).toBe(true)
	})
}) 