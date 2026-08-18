import { describe, expect, it } from 'vitest'
import { camelCaseToUnderscore, get, set, toCamelCase, transformRpx } from '../src/core/utils'

describe('自定义数据转换', () => {
	it('连字符写法会转换成驼峰写法', () => {
		expect(toCamelCase('element-type')).toEqual('elementType')
	})

	it('大写字符会自动转成小写字符', () => {
		expect(toCamelCase('elementType')).toEqual('elementtype')
	})
})

describe('组件名转下划线', () => {
	it('一个单词', () => {
		expect(camelCaseToUnderscore('Switch')).toEqual('switch')
	})

	it('两个单词', () => {
		expect(camelCaseToUnderscore('PickerView')).toEqual('picker-view')
	})

	it('三个单词', () => {
		expect(camelCaseToUnderscore('PickerViewColumn')).toEqual('picker-view-column')
	})
})

describe('path get/set', () => {
	it('gets nested values with dot and bracket paths', () => {
		const data = { a: { b: [{ c: 1 }] }, x: { 'y.z': 2 } }

		expect(get(data, 'a.b[0].c')).toBe(1)
		expect(get(data, ['x', 'y.z'])).toBe(2)
		expect(get(data, 'a.b[1].c')).toBeUndefined()
	})

	it('sets nested values and creates missing containers', () => {
		const data = {}

		set(data, 'a.b[0].c', 1)
		set(data, ['x', 'y.z'], 2)

		expect(data).toEqual({
			a: { b: [{ c: 1 }] },
			x: { 'y.z': 2 },
		})
	})
})

describe('rpx conversion', () => {
	it('keeps rpx independent from rem root font size', () => {
		expect(transformRpx('width:750rpx;margin-left:-7.5rpx;font-size:1rem'))
			.toBe('width:100vw;margin-left:-1vw;font-size:1rem')
	})
})
