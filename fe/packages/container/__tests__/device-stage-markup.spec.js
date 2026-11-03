import fs from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('device stage markup', () => {
	it('renders the Wi-Fi status icon with theme-aware arcs and dot', () => {
		const markup = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.html'), 'utf8')
		const deviceStyles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.scss'), 'utf8')
		const wifiMarkup = markup.match(/<svg class="status-bar__wifi"[^>]*>[\s\S]*?<\/svg>/)?.[0]

		expect(wifiMarkup).toBeDefined()
		expect(wifiMarkup).toContain('viewBox="0 0 18 14"')
		expect(wifiMarkup).toContain('aria-hidden="true"')
		expect(wifiMarkup).toMatch(/<path[^>]*fill="none"[^>]*stroke="currentColor"/)
		expect(wifiMarkup).toMatch(/<circle[^>]*fill="currentColor"/)
		expect(wifiMarkup).not.toContain('fill-rule=')
		expect(deviceStyles).toMatch(/\.status-bar__wifi\s*{[^}]*width:\s*18px;[^}]*height:\s*14px;/s)
		expect(deviceStyles).not.toMatch(/\.status-bar__wifi\s*{\s*fill:\s*#(?:fff|000);\s*stroke:\s*#(?:fff|000);/s)
	})

	it('keeps the split demo layout and platform order', () => {
		const markup = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.html'), 'utf8')
		const stageStyles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device-stage.scss'), 'utf8')
		const deviceStyles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.scss'), 'utf8')
		const tokens = fs.readFileSync(resolve(process.cwd(), 'tokens.css'), 'utf8')

		expect(markup).toContain('device-stage__orbit')
		expect(markup).toContain('device-stage__orbit-light')
		expect(markup).toContain('device-stage__statement')
		expect(markup).toContain('<h1>一份小程序<br>在<span>四个平台</span>运行</h1>')
		expect(markup).toContain('aria-label="小程序实时预览"')
		expect(markup).toMatch(/<li class="is-current">Web<\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/android\/README\.md" target="_blank" rel="noreferrer">Android 接入文档<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/iOS\/README\.md" target="_blank" rel="noreferrer">iOS 接入文档<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/harmony\/dimina\/README\.md" target="_blank" rel="noreferrer">Harmony 接入文档<\/a><\/li>/)
		expect(markup).toContain('class="device-stage__device"')
		expect(stageStyles).toMatch(/&-light\s*{[^}]*border:\s*2px solid var\(--color-accent\);/s)
		expect(stageStyles).not.toMatch(/&-light\s*{[^}]*filter:/s)
		expect(stageStyles).toContain('transform: rotate(var(--orbit-light-angle));')
		expect(stageStyles).not.toMatch(/&__statement\s*{[^}]*background:/s)
		expect(stageStyles).toMatch(/@media \(max-width: 46rem\)\s*{\s*\.device-stage\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\);/)
		expect(stageStyles).toMatch(/html,\s*body\s*{\s*overflow-x:\s*clip;/)
		expect(stageStyles).toMatch(/\.device-stage\s*{[^}]*font-family:\s*var\(--font-body\);/s)
		expect(tokens).toContain('--color-accent: oklch(58% 0.2 256);')
		expect(deviceStyles).not.toContain('device-stage__statement')
		expect(deviceStyles).toContain('font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;')
	})
})
