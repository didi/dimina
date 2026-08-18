import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('mini-program template semantics', () => {
	let tempDir
	let originalTargetPath
	let compileIndex = 0

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-semantics-'))
	})

	afterEach(() => {
		vi.restoreAllMocks()
		if (originalTargetPath) process.env.TARGET_PATH = originalTargetPath
		else delete process.env.TARGET_PATH
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function compilePage(template, options = {}) {
		const usingComponents = options.usingComponents || {
			'info-card': '/components/info-card',
		}
		const componentFixtures = options.componentFixtures || [{
			path: 'components/info-card/index',
			config: { component: true },
			template: '<view><slot name="info"></slot></view>',
		}]
		const pagePath = `pages/index-${compileIndex++}`
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: [pagePath],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'template-semantics',
		}))
		fs.mkdirSync(path.join(tempDir, 'pages'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, `${pagePath}.json`), JSON.stringify({
			usingComponents,
		}))
		fs.writeFileSync(path.join(tempDir, `${pagePath}.wxml`), template)
		for (const fixture of componentFixtures) {
			const componentBasePath = path.join(tempDir, fixture.path)
			fs.mkdirSync(path.dirname(componentBasePath), { recursive: true })
			fs.writeFileSync(`${componentBasePath}.json`, JSON.stringify(fixture.config))
			fs.writeFileSync(`${componentBasePath}.wxml`, fixture.template)
		}

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)
		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })
		return fs.readFileSync(path.join(outputDir, `main/${pagePath.replace(/\//g, '_')}.js`), 'utf8')
	}

	it('keeps all nodes from duplicate named slots', async () => {
		const output = await compilePage(`
			<info-card>
				<text slot="info">成功</text>
				<text slot="info">失败</text>
			</info-card>
		`)

		expect(output).toContain('\\u6210\\u529F')
		expect(output).toContain('\\u5931\\u8D25')
	})

	it('evaluates wx:if inside the wx:for item scope', async () => {
		const output = await compilePage(`
			<view wx:for="{{ list }}" wx:for-item="entry" wx:key="id" wx:if="{{ entry.visible }}">
				{{entry.name}}
			</view>
		`)

		expect(output).toMatch(/_renderList\([^]*=>[^]*\.visible\?/)
		expect(output.indexOf('.visible')).toBeGreaterThan(output.indexOf('_renderList'))
	})

	it('keeps the loop item scope inside a named slot', async () => {
		const output = await compilePage(`
			<info-card>
				<text slot="info" wx:for="{{ list }}" wx:if="{{ item.visible }}">
					{{item.name}}
				</text>
			</info-card>
		`)

		expect(output).toMatch(/info:_withCtx\([^]*_renderList\([^]*=>[^]*\.visible\?/)
		expect(output.indexOf('.visible')).toBeGreaterThan(output.indexOf('_renderList'))
	})

	it('keeps HTML and undeclared tags native while registered components win resolution', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const output = await compilePage(`
			<page-meta root-font-size="system" />
			<view>
				<div><span><p>paragraph</p></span></div>
				<strong class="emphasis"><i>Bold italic</i></strong>
				<em><b><small>emphasis</small></b></em>
				<sub>sub</sub><sup>sup</sup><code>code</code>
				<blockquote><ul><li>item</li></ul></blockquote>
				<table><tbody><tr><td>cell</td></tr></tbody></table>
				<unknown-html data-native="true" />
				<info-card />
			</view>
		`)

		for (const tag of [
			'div', 'span', 'p', 'strong', 'i', 'em', 'b', 'small', 'sub', 'sup',
			'code', 'blockquote', 'ul', 'li', 'table', 'tbody', 'tr', 'td', 'unknown-html',
		]) {
			expect(output).toContain(`"${tag}"`)
			expect(output).not.toContain(`_resolveComponent("dd-${tag}")`)
		}
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('<unknown-html>'))
		expect(output).toContain('dd-page-meta')
		expect(output).toContain('"dimina-rpx-unit":"vw"')
		expect(output).toContain('dd-info-card')
		expect(output).not.toContain('resolveComponent("unknown-html")')
		expect(output).not.toContain('dd-text')
	})

	it('preserves custom-component style as both host style and a declared property', async () => {
		const output = await compilePage('<info-card style="height: {{cardHeight}}rpx" />')

		expect(output).toContain('dd-component-host')
		expect(output).not.toContain('dd-wrapper')
		expect(output).toContain('"dimina-wxml-style"')
		expect(output).toContain('_resolveDirective("c-style")')
		expect(output).toMatch(/style:\{expression:"'height: '\+cardHeight\+'rpx'"/)
	})

	it('compiles a custom component that declares and renders itself', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const output = await compilePage('<tree-node depth="3" />', {
			usingComponents: {
				'tree-node': '/components/tree-node',
			},
			componentFixtures: [{
				path: 'components/tree-node/index',
				config: {
					component: true,
					usingComponents: {
						'tree-node': '/components/tree-node',
					},
				},
				template: '<view><tree-node wx:if="{{depth > 0}}" depth="{{depth - 1}}" /></view>',
			}],
		})

		expect(output).toContain('dd-tree-node')
		expect(output).not.toContain('dd-text')
		expect(warn).not.toHaveBeenCalled()
	})

	it('silently compiles mutually recursive custom components', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const output = await compilePage('<node-a />', {
			usingComponents: {
				'node-a': '/components/node-a',
			},
			componentFixtures: [
				{
					path: 'components/node-a',
					config: {
						component: true,
						usingComponents: { 'node-b': '/components/node-b' },
					},
					template: '<view><node-b /></view>',
				},
				{
					path: 'components/node-b',
					config: {
						component: true,
						usingComponents: { 'node-a': '/components/node-a' },
					},
					template: '<view><node-a /></view>',
				},
			],
		})

		expect(output).toContain('dd-node-a')
		expect(output).toContain('dd-node-b')
		expect(warn).not.toHaveBeenCalled()
	})

	it('compiles a deep acyclic component chain without a fixed depth cutoff', async () => {
		const depth = 24
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const componentFixtures = Array.from({ length: depth }, (_, index) => {
			const hasChild = index < depth - 1
			return {
				path: `components/deep-${index}`,
				config: {
					component: true,
					usingComponents: hasChild
						? { [`deep-${index + 1}`]: `/components/deep-${index + 1}` }
						: {},
				},
				template: hasChild
					? `<view><deep-${index + 1} /></view>`
					: '<view>leaf</view>',
			}
		})

		const output = await compilePage('<deep-0 />', {
			usingComponents: { 'deep-0': '/components/deep-0' },
			componentFixtures,
		})

		expect(output).toContain(`"/components/deep-${depth - 1}"`)
		expect(warn).not.toHaveBeenCalled()
	})
})
