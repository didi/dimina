import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// canvas 的组件实现（Canvas.vue）只有在编译产物把它解析成 dd-canvas 时才会被执行。
// 一旦它退回原生元素，canvas-id 判重、binderror、覆盖层插槽会一起失效，而组件包和渲染层
// 的单测各自仍然全绿——两侧分开测都对，只有产物能证明它们接在同一条链上。
describe('canvas 视图编译', () => {
	let tempDir
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-component-path-'))
		// 项目信息与页面表是编译器的模块级状态，不重置的话后一个用例会编到前一个用例的 WXML。
		vi.resetModules()
	})

	afterEach(() => {
		if (originalTargetPath) {
			process.env.TARGET_PATH = originalTargetPath
		}
		else {
			delete process.env.TARGET_PATH
		}

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	async function compilePage(wxml) {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))
		fs.mkdirSync(path.join(tempDir, 'pages/home'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.json'), JSON.stringify({}))
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxml'), wxml)

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		return fs.readFileSync(path.join(outputDir, 'main/pages_home_index.js'), 'utf-8')
	}

	it('把 canvas 解析成组件而不是原生元素', async () => {
		const output = await compilePage('<canvas canvas-id="chart" />')

		expect(output).toContain('_resolveComponent("dd-canvas")')
		expect(output).not.toContain('_createElementVNode("canvas"')
	})

	// 微信只允许 cover-view / cover-image 嵌在 canvas 里当覆盖层，靠的是组件自己的插槽。
	// 留在原生 canvas 下时它们是 HTML 的回退内容，浏览器根本不布局，覆盖层会整个消失。
	it('让 canvas 的覆盖层子节点挂在组件下', async () => {
		const output = await compilePage('<canvas canvas-id="chart"><cover-view>overlay</cover-view></canvas>')

		expect(output).toContain('_resolveComponent("dd-canvas")')
		expect(output).toContain('_resolveComponent("dd-cover-view")')
		expect(output).not.toContain('_createElementVNode("canvas"')
	})

	// canvas 走组件路径后仍然要保留 WXML 上声明的属性，判重和手势都从这里取值。
	it('保留 canvas 上声明的属性', async () => {
		const output = await compilePage('<canvas canvas-id="chart" type="2d" disable-scroll />')

		expect(output).toContain('canvas-id')
		expect(output).toContain('disable-scroll')
		expect(output).toContain('type')
	})
})
