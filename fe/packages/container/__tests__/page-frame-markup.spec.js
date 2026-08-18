import fs from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('page frame markup', () => {
	it('keeps the page marker on the stable frame container', () => {
		const markup = fs.readFileSync(resolve(process.cwd(), 'pageFrame.html'), 'utf8')

		expect(markup).toMatch(/<body\s+class=["']dd-page["']>/)
	})
})
