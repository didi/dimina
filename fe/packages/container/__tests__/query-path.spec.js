import { describe, expect, it } from 'vitest'
import { queryPath } from '../src/utils/util'

// 守护 queryPath 的前导斜杠归一化：app-config.json 的 modules key 与 AMD module id
// 均为无前导斜杠形态，宿主直启 path 与容器内 "/pages/x/y" 写法必须在此单点归一，
// 否则页面配置查找与 service 模块加载会因写法发散而失败
describe('queryPath leading-slash normalization', () => {
	it('strips a leading slash so the path matches app-config module keys', () => {
		expect(queryPath('/pages/index/index').pagePath).toBe('pages/index/index')
	})

	it('strips repeated leading slashes', () => {
		expect(queryPath('//pages/index/index').pagePath).toBe('pages/index/index')
	})

	it('keeps already-normalized paths and query parsing intact', () => {
		const { pagePath, query } = queryPath('pages/detail/detail?id=1')
		expect(pagePath).toBe('pages/detail/detail')
		expect(query).toEqual({ id: '1' })
	})

	it('normalizes the path part of a slash-prefixed url with query', () => {
		const { pagePath, query } = queryPath('/pages/detail/detail?id=1&from=share')
		expect(pagePath).toBe('pages/detail/detail')
		expect(query).toEqual({ id: '1', from: 'share' })
	})
})
