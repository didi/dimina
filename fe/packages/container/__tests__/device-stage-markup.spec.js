import fs from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('device stage markup', () => {
	it('keeps the approved white-gallery structure and platform order', () => {
		const markup = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.html'), 'utf8')
		const stageStyles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device-stage.scss'), 'utf8')
		const deviceStyles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.scss'), 'utf8')
		const tokens = fs.readFileSync(resolve(process.cwd(), 'tokens.css'), 'utf8')

		expect(markup).toContain('device-stage__orbit')
		expect(markup).toContain('device-stage__orbit-light')
		expect(markup).toContain('device-stage__statement')
		expect(markup).toMatch(/一套小程序代码\s*<br>\s*在四个平台真实运行/)
		expect(markup).toContain('>LIVE DEMO</div>')
		expect(markup).toMatch(/<li class="is-current">Web<\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/android\/README\.md" target="_blank" rel="noreferrer">Android<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/iOS\/README\.md" target="_blank" rel="noreferrer">iOS<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/harmony\/dimina\/README\.md" target="_blank" rel="noreferrer">Harmony<\/a><\/li>/)
		expect(stageStyles).toMatch(/&__device\s*{[^}]*inset-inline-start:\s*50%;/s)
		expect(stageStyles).toMatch(/&-light\s*{[^}]*border:\s*3px solid var\(--color-accent\);/s)
		expect(stageStyles).not.toMatch(/&-light\s*{[^}]*filter:/s)
		expect(stageStyles).toContain('transform: rotate(var(--orbit-light-angle));')
		expect(stageStyles).toContain('z-index: 5;')
		expect(stageStyles).not.toMatch(/&__statement\s*{[^}]*background:/s)
		expect(stageStyles).toMatch(/@media \(min-width: 60rem\)\s*{\s*\.device-stage__statement\s*{\s*display:\s*block;/)
		expect(stageStyles).toMatch(/html,\s*body\s*{\s*overflow-x:\s*clip;/)
		expect(stageStyles).not.toMatch(/\.device-stage\s*{[^}]*font-family:/s)
		expect(tokens).toContain('--color-accent: oklch(58% 0.2 256);')
		expect(deviceStyles).not.toContain('device-stage__statement')
		expect(deviceStyles).toContain('font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;')
	})
})
