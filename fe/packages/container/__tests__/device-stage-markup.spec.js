import fs from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('device stage markup', () => {
	it('keeps the approved white-gallery structure and platform order', () => {
		const markup = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.html'), 'utf8')
		const styles = fs.readFileSync(resolve(process.cwd(), 'src/pages/device/device.scss'), 'utf8')

		expect(markup).toContain('device-stage__orbit')
		expect(markup).toContain('device-stage__orbit-light')
		expect(markup).toContain('device-stage__statement')
		expect(markup).toMatch(/一套小程序代码\s*<br>\s*在四个平台真实运行/)
		expect(markup).toContain('>LIVE DEMO</div>')
		expect(markup).toMatch(/<li class="is-current">Web<\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/android\/README\.md" target="_blank" rel="noreferrer">Android<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/iOS\/README\.md" target="_blank" rel="noreferrer">iOS<\/a><\/li>\s*<li><a href="https:\/\/github\.com\/didi\/dimina\/blob\/HEAD\/harmony\/dimina\/README\.md" target="_blank" rel="noreferrer">Harmony<\/a><\/li>/)
		expect(styles).toMatch(/&__device\s*{[^}]*left:\s*50%;/s)
		expect(styles).toMatch(/&-light\s*{[^}]*background:\s*var\(--glow\);/s)
		expect(styles.match(/var\(--glow\)/g)).toHaveLength(1)
		expect(styles).toContain('--accent: #0878ff;')
		expect(styles).not.toContain('--hue')
		expect(styles).toMatch(/@media \(max-width: 920px\)\s*{\s*\.device-stage__statement\s*{\s*display:\s*none;/)
		expect(styles).not.toMatch(/\.device-stage\s*{[^}]*font-family:/s)
	})
})
