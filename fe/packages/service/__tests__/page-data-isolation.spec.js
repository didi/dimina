import { describe, expect, it } from 'vitest'
import { PageModule } from '../src/instance/page/page-module'
import { Page } from '../src/instance/page/page'

describe('Page data isolation', () => {
	function createPageModule() {
		return new PageModule({
			data: {
				count: 0,
				profile: { nick: 'anonymous' },
			},
		}, {
			path: 'pages/demo/index',
			usingComponents: {},
		})
	}

	function createPage(pageModule, bridgeId) {
		const page = new Page(pageModule, {
			bridgeId,
			moduleId: `${bridgeId}-module`,
			path: 'pages/demo/index',
			query: {},
		})
		page.init()
		return page
	}

	it('starts a new instance from the declared defaults', () => {
		const pageModule = createPageModule()
		const first = createPage(pageModule, 'bridge-first')

		first.setData({ count: 1 })
		first.setData({ 'profile.nick': 'first' })

		const second = createPage(pageModule, 'bridge-second')
		expect(second.data).toEqual({
			count: 0,
			profile: { nick: 'anonymous' },
		})
	})

	it('does not modify the module data declaration', () => {
		const pageModule = createPageModule()
		const page = createPage(pageModule, 'bridge-only')

		page.setData({ count: 42 })
		page.setData({ 'profile.nick': 'written' })

		expect(pageModule.moduleInfo.data).toEqual({
			count: 0,
			profile: { nick: 'anonymous' },
		})
		expect(pageModule.noReferenceData).toEqual({
			count: 0,
			profile: { nick: 'anonymous' },
		})
	})

	it('keeps live instances independent', () => {
		const pageModule = createPageModule()
		const first = createPage(pageModule, 'bridge-a')
		const second = createPage(pageModule, 'bridge-b')

		first.setData({ count: 7 })
		second.setData({ count: 9 })

		expect(first.data.count).toBe(7)
		expect(second.data.count).toBe(9)
		expect(first.data).not.toBe(second.data)
	})
})
