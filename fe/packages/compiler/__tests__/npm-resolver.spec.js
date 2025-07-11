import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { NpmResolver } from '../src/common/npm-resolver.js'

describe('NpmResolver', () => {
	let tempDir
	let npmResolver

	beforeEach(() => {
		// 创建临时测试目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-resolver-test-'))
		npmResolver = new NpmResolver(tempDir)
	})

	afterEach(() => {
		// 清理临时目录
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	describe('resolveComponentPath', () => {
		it('应该正确解析相对路径组件', () => {
			const pageFilePath = path.join(tempDir, 'pages/index/index.js')
			const componentPath = './components/button'
			
			const result = npmResolver.resolveComponentPath(componentPath, pageFilePath)
			expect(result).toBe('/pages/index/components/button')
		})

		it('应该正确解析绝对路径组件', () => {
			const pageFilePath = path.join(tempDir, 'pages/index/index.js')
			const componentPath = '/components/button'
			
			const result = npmResolver.resolveComponentPath(componentPath, pageFilePath)
			expect(result).toBe('/components/button')
		})

		it('应该尝试解析 npm 包组件', () => {
			// 创建 miniprogram_npm 目录结构
			const miniprogramNpmPath = path.join(tempDir, 'miniprogram_npm')
			const packagePath = path.join(miniprogramNpmPath, 'test-component')
			
			fs.mkdirSync(packagePath, { recursive: true })
			fs.writeFileSync(path.join(packagePath, 'index.json'), JSON.stringify({ component: true }))
			fs.writeFileSync(path.join(packagePath, 'index.js'), 'Component({})')
			fs.writeFileSync(path.join(packagePath, 'index.wxml'), '<view>test</view>')
			fs.writeFileSync(path.join(packagePath, 'index.wxss'), '.test {}')

			const pageFilePath = path.join(tempDir, 'pages/index/index.js')
			const componentPath = 'test-component'
			
			const result = npmResolver.resolveComponentPath(componentPath, pageFilePath)
			expect(result).toBe('/miniprogram_npm/test-component')
		})
	})

	describe('generateSearchPaths', () => {
		it('应该生成正确的搜索路径', () => {
			const pageFilePath = path.join(tempDir, 'pages/subpackage/detail/index.js')
			const searchPaths = npmResolver.generateSearchPaths(pageFilePath)
			
			expect(searchPaths).toEqual([
				'pages/subpackage/detail/miniprogram_npm',
				'pages/subpackage/miniprogram_npm',
				'pages/miniprogram_npm',
				'miniprogram_npm'
			])
		})

		it('应该为根目录文件生成正确的搜索路径', () => {
			const pageFilePath = path.join(tempDir, 'app.js')
			const searchPaths = npmResolver.generateSearchPaths(pageFilePath)
			
			expect(searchPaths).toEqual([
				'miniprogram_npm'
			])
		})
	})

	describe('findComponentInMiniprogramNpm', () => {
		it('应该找到存在的组件', () => {
			// 创建测试组件
			const miniprogramNpmPath = path.join(tempDir, 'miniprogram_npm')
			const componentPath = path.join(miniprogramNpmPath, 'test-component')
			
			fs.mkdirSync(componentPath, { recursive: true })
			fs.writeFileSync(path.join(componentPath, 'index.json'), JSON.stringify({ component: true }))
			fs.writeFileSync(path.join(componentPath, 'index.js'), 'Component({})')

			const result = npmResolver.findComponentInMiniprogramNpm('test-component', 'miniprogram_npm')
			expect(result).toBe('/miniprogram_npm/test-component')
		})

		it('应该找到带 index 的组件', () => {
			// 创建测试组件 - 只有 index 目录下有组件文件
			const miniprogramNpmPath = path.join(tempDir, 'miniprogram_npm')
			const componentIndexPath = path.join(miniprogramNpmPath, 'test-component', 'index')
			
			fs.mkdirSync(componentIndexPath, { recursive: true })
			fs.writeFileSync(path.join(componentIndexPath, 'index.json'), JSON.stringify({ component: true }))
			fs.writeFileSync(path.join(componentIndexPath, 'index.js'), 'Component({})')

			const result = npmResolver.findComponentInMiniprogramNpm('test-component', 'miniprogram_npm')
			expect(result).toBe('/miniprogram_npm/test-component/index')
		})

		it('应该返回 null 如果组件不存在', () => {
			const result = npmResolver.findComponentInMiniprogramNpm('non-existent', 'miniprogram_npm')
			expect(result).toBeNull()
		})
	})

	describe('isValidComponent', () => {
		it('应该验证有效的组件', () => {
			const componentPath = path.join(tempDir, 'test-component')
			
			fs.mkdirSync(componentPath, { recursive: true })
			fs.writeFileSync(`${componentPath}.json`, JSON.stringify({ component: true }))
			fs.writeFileSync(`${componentPath}.js`, 'Component({})')

			const result = npmResolver.isValidComponent(componentPath)
			expect(result).toBe(true)
		})

		it('应该拒绝无效的组件', () => {
			const componentPath = path.join(tempDir, 'invalid-component')
			
			fs.mkdirSync(componentPath, { recursive: true })
			// 只创建一个文件，不足以构成有效组件

			const result = npmResolver.isValidComponent(componentPath)
			expect(result).toBe(false)
		})

		it('应该拒绝未标记为组件的文件', () => {
			const componentPath = path.join(tempDir, 'not-component')
			
			fs.mkdirSync(componentPath, { recursive: true })
			fs.writeFileSync(`${componentPath}.json`, JSON.stringify({ component: false }))
			fs.writeFileSync(`${componentPath}.js`, 'Page({})')

			const result = npmResolver.isValidComponent(componentPath)
			expect(result).toBe(false)
		})
	})

	describe('缓存功能', () => {
		it('应该缓存解析结果', () => {
			// 创建测试组件
			const miniprogramNpmPath = path.join(tempDir, 'miniprogram_npm')
			const componentPath = path.join(miniprogramNpmPath, 'cached-component')
			
			fs.mkdirSync(componentPath, { recursive: true })
			fs.writeFileSync(path.join(componentPath, 'index.json'), JSON.stringify({ component: true }))
			fs.writeFileSync(path.join(componentPath, 'index.js'), 'Component({})')

			// 第一次调用
			const result1 = npmResolver.findComponentInMiniprogramNpm('cached-component', 'miniprogram_npm')
			
			// 删除文件（模拟缓存场景）
			fs.rmSync(componentPath, { recursive: true, force: true })
			
			// 第二次调用应该返回缓存结果
			const result2 = npmResolver.findComponentInMiniprogramNpm('cached-component', 'miniprogram_npm')
			
			expect(result1).toBe(result2)
			expect(result1).toBe('/miniprogram_npm/cached-component')
		})

		it('应该能够清除缓存', () => {
			npmResolver.miniprogramNpmCache.set('test', 'value')
			npmResolver.packageCache.set('test', 'value')
			
			npmResolver.clearCache()
			
			expect(npmResolver.miniprogramNpmCache.size).toBe(0)
			expect(npmResolver.packageCache.size).toBe(0)
		})
	})
}) 