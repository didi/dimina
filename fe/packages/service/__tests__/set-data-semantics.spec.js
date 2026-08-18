import { getDataFunctionReferenceId, isDataFunctionReference } from '@dimina/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDataFunction } from '../src/core/data-function'
import { resetUpdateQueues } from '../src/core/update-queue'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { Page } from '../src/instance/page/page'

describe('Skyline/exparser setData semantics', () => {
	const sentMessages = []

	beforeEach(() => {
		sentMessages.length = 0
		resetUpdateQueues()
		runtime.instances = {}
		globalThis.DiminaServiceBridge.publish = vi.fn((_bridgeId, msg) => {
			sentMessages.push(msg)
			return Promise.resolve()
		})
	})

	function makePage(info = {}) {
		const page = {
			data: {},
			initd: true,
			bridgeId: 'bridge-set-data',
			__id__: 'page-set-data',
			__info__: info,
			__childPropsBindings__: {},
		}
		page.setData = Page.prototype.setData
		runtime.instances[page.bridgeId] = { [page.__id__]: page }
		return page
	}

	it('supports escaped keys and numeric bracket paths while rejecting non-numeric brackets', () => {
		const page = makePage()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		page.setData({
			'a\\.b.value': 1,
			'list[1].name': 'second',
			container: {},
			'container[0]': 'array-item',
			objectValue: [],
			'objectValue.name': 'object-field',
			'list[name]': 'invalid',
			'[0].value': 'invalid',
		})

		expect(page.data).toEqual({
			'a.b': { value: 1 },
			list: [undefined, { name: 'second' }],
			container: ['array-item'],
			objectValue: { name: 'object-field' },
		})
		expect(warn).toHaveBeenCalledTimes(2)
		warn.mockRestore()
	})

	it('clones reference values for logic and bridges functions by stable reference', async () => {
		const page = makePage()
		const shared = { value: 1 }
		const source = {
			left: shared,
			right: shared,
			createdAt: new Date('2025-01-02T03:04:05.000Z'),
			method() {},
		}

		page.setData({ item: source })
		source.left.value = 9

		expect(page.data.item).not.toBe(source)
		expect(page.data.item.left).toBe(page.data.item.right)
		expect(page.data.item.left.value).toBe(1)
		expect(page.data.item.createdAt).toBeInstanceOf(Date)
		expect(page.data.item.method).toBe(source.method)

		await Promise.resolve()
		const update = sentMessages[0].body.updates[0]
		expect(update.data.item).toMatchObject({
			left: { value: 1 },
			right: { value: 1 },
			createdAt: '2025-01-02T03:04:05.000Z',
		})
		expect(isDataFunctionReference(update.data.item.method)).toBe(true)
		expect(resolveDataFunction(getDataFunctionReferenceId(update.data.item.method))).toBe(source.method)
	})

	it('keeps direct and array function assignments in both data and change records', async () => {
		const page = makePage()
		const fn = () => 'value'

		page.setData({ fn, list: [fn] })

		expect(page.data.fn).toBe(fn)
		expect(page.data.list[0]).toBe(fn)

		await Promise.resolve()
		const update = sentMessages[0].body.updates[0]
		const fnReference = update.data.fn
		expect(isDataFunctionReference(fnReference)).toBe(true)
		expect(update.data.list[0]).toEqual(fnReference)
		expect(update.changes).toEqual([
			{ path: ['fn'], value: fnReference },
			{ path: ['list'], value: [fnReference] },
		])
	})

	it('runs behavior observers before component observers without old values and drains nested setData', async () => {
		const calls = []
		const page = makePage({
			behaviorObserverList: [{
				key: 'count',
				observer(...args) {
					calls.push(['behavior:count', args.length, args[0]])
					this.setData({ mirrored: args[0] })
				},
			}],
			observers: {
				count(...args) {
					calls.push(['page:count', args.length, args[0]])
				},
				mirrored(value) {
					calls.push(['page:mirrored', arguments.length, value])
				},
			},
		})

		page.setData({ count: 2 })

		expect(calls).toEqual([
			['behavior:count', 1, 2],
			['page:count', 1, 2],
			['page:mirrored', 1, 2],
		])
		expect(page.data).toEqual({ count: 2, mirrored: 2 })

		await Promise.resolve()
		expect(sentMessages[0].body.updates[0].data).toEqual({ count: 2, mirrored: 2 })
	})

	it('requires a deep wildcard for descendant assignments but observes ancestor replacement', () => {
		const calls = []
		const page = makePage({
			observers: {
				profile(value) {
					calls.push(['profile', value])
				},
				'profile.name'(value) {
					calls.push(['profile.name', value])
				},
				'profile.**'(value) {
					calls.push(['profile.**', value])
				},
			},
		})

		page.setData({ 'profile.name.first': 'Ada' })
		expect(calls).toEqual([
			['profile.**', { name: { first: 'Ada' } }],
		])

		calls.length = 0
		page.setData({ profile: { name: { first: 'Grace' } } })
		expect(calls).toEqual([
			['profile', { name: { first: 'Grace' } }],
			['profile.name', { first: 'Grace' }],
			['profile.**', { name: { first: 'Grace' } }],
		])
	})

	it('runs property observers in assignment order and passes the full nested update path', async () => {
		const calls = []
		const component = {
			data: { profile: { name: 'old' }, visible: false },
			initd: true,
			bridgeId: 'bridge-properties',
			__id__: 'component-properties',
			__info__: {
				properties: {
					profile: {
						observer(value, oldValue, path) {
							calls.push(['profile', value, oldValue, path])
						},
					},
					visible: {
						observer(value) {
							calls.push(['visible', value])
						},
					},
				},
			},
			__childPropsBindings__: {},
		}
		component.setData = Component.prototype.setData
		runtime.instances[component.bridgeId] = { [component.__id__]: component }

		component.setData({
			'profile.name': 'new',
			visible: true,
		})

		expect(calls).toEqual([
			['profile', 'new', undefined, ['profile', 'name']],
			['visible', true],
		])

		await Promise.resolve()
		expect(sentMessages[0].body.updates[0].changes).toEqual([
			{ path: ['profile', 'name'], value: 'new' },
			{ path: ['visible'], value: true },
		])
	})

	it('preserves each chained property assignment for property observers and render', async () => {
		const propertyCalls = []
		const component = {
			data: { count: 0 },
			initd: true,
			bridgeId: 'bridge-chained-property',
			__id__: 'component-chained-property',
			__info__: {
				observers: {
					count(value) {
						if (value === 1) {
							this.setData({ count: 2 })
						}
					},
				},
				properties: {
					count: {
						observer(value, oldValue) {
							propertyCalls.push([value, oldValue])
						},
					},
				},
			},
			__childPropsBindings__: {},
		}
		component.setData = Component.prototype.setData
		runtime.instances[component.bridgeId] = { [component.__id__]: component }

		component.setData({ count: 1 })
		expect(propertyCalls).toEqual([[1, 0], [2, 1]])

		await Promise.resolve()
		expect(sentMessages[0].body.updates[0].changes).toEqual([
			{ path: ['count'], value: 1 },
			{ path: ['count'], value: 2 },
		])
	})
})
