import { afterEach, describe, expect, it } from 'vitest'
import runtime from '../src/core/runtime'
import { Page } from '../src/instance/page/page'

describe('Page.getTabBar', () => {
	const bridgeId = 'custom-tab-bar-bridge'

	afterEach(() => {
		delete runtime.instances[bridgeId]
	})

	it('returns the custom tabBar component in the current page tree', () => {
		const page = new Page({
			noReferenceData: {},
			type: 'page',
			moduleInfo: {},
		}, {
			path: 'pages/home/index',
			bridgeId,
			moduleId: 'page-id',
			query: {},
		})
		const tabBar = {
			__id__: 'tab-bar-id',
			__parentId__: 'page-id',
			__isComponent__: true,
			__isCustomTabBar__: true,
			is: '/components/application-defined-tab-bar',
		}
		runtime.instances[bridgeId] = {
			'page-id': page,
			'tab-bar-id': tabBar,
		}

		expect(page.getTabBar()).toBe(tabBar)
	})

	it('returns null outside a custom tab page', () => {
		const page = new Page({
			noReferenceData: {},
			type: 'page',
			moduleInfo: {},
		}, {
			path: 'pages/detail/index',
			bridgeId,
			moduleId: 'page-id',
			query: {},
		})
		runtime.instances[bridgeId] = { 'page-id': page }

		expect(page.getTabBar()).toBeNull()
	})
})
