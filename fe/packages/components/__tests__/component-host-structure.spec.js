import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const COMPONENT_HOST_FILE = fileURLToPath(new URL('../src/component/component-host/ComponentHost.vue', import.meta.url))

describe('ComponentHost component structure', () => {
	it('keeps the custom component tag without creating a browser ShadowRoot', () => {
		const source = fs.readFileSync(COMPONENT_HOST_FILE, 'utf-8')

		expect(source).toContain('<component :is="componentName" v-bind="$attrs">')
		expect(source).not.toContain('attachShadow')
		expect(source).not.toContain('createShadowDOM')
		expect(source).not.toMatch(/\bref=/)
	})
})
