import { describe, expect, it } from 'vitest'
import { PageModule } from '../src/instance/page/page-module'
import { Page } from '../src/instance/page/page'

/**
 * 每个页面实例持有自己的 data 副本：同一个页面模块被打开多次（navigateTo / navigateBack 后再进入、redirectTo、switchTab 重建 tab 页）时，后开的实例必须从模块声明的默认值起步，看不到先前实例 setData 写入的值。
 */
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

	it('starts a second instance of the same module from the declared defaults', () => {
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

	it('leaves the module-level data declaration untouched when an instance writes', () => {
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

	it('keeps two live instances of the same module writing to separate data', () => {
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
