import { describe, expect, it } from 'vitest'
import { HashRouter } from '../src/utils/hashRouter'

describe('HashRouter query route', () => {
	it('should parse appId, entry and page from query route', () => {
		const route = HashRouter.parse('', '?appId=wxbaf4b47de04f1d8a&entry=pages/index&page=pages/web-gl/index')

		expect(route).toEqual({
			appId: 'wxbaf4b47de04f1d8a',
			stack: [
				{ pagePath: 'pages/index', query: {} },
				{ pagePath: 'pages/web-gl/index', query: {} },
			],
		})
	})

	it('should keep old hash route compatible', () => {
		const route = HashRouter.parse('#wxbaf4b47de04f1d8a|pages/index|pages/web-gl/index', '')

		expect(route).toEqual({
			appId: 'wxbaf4b47de04f1d8a',
			stack: [
				{ pagePath: 'pages/index', query: {} },
				{ pagePath: 'pages/web-gl/index', query: {} },
			],
		})
	})

	it('should build readable query route and preserve unrelated params', () => {
		const search = HashRouter.buildRouteSearch('wxbaf4b47de04f1d8a', [
			{ pagePath: 'pages/index', query: {} },
			{ pagePath: 'pages/web-gl/index', query: {} },
		], '?vconsole=1&appId=old')

		expect(search).toBe('vconsole=1&appId=wxbaf4b47de04f1d8a&entry=pages/index&page=pages/web-gl/index')
	})
})
