import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'
import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'
import { resetUpdateQueues } from '../src/core/update-queue'
import runtime from '../src/core/runtime'

describe('pureDataPattern', () => {
	let sent
	beforeEach(() => {
		sent = []
		resetUpdateQueues()
		runtime.instances = {}
		globalThis.DiminaServiceBridge.publish = vi.fn((_id, msg) => { sent.push(msg); return Promise.resolve() })
	})
	function create(info, { page = false, jsonPattern } = {}) {
		const extra = { component: !page, usingComponents: {}, ...(jsonPattern === undefined ? {} : { pureDataPattern: jsonPattern }) }
		const module = page ? new PageModule(info, extra) : new ComponentModule(info, extra)
		const instance = new (page ? Page : Component)(module, { bridgeId: 'pure', moduleId: 'instance', path: 'pure', properties: {} })
		runtime.instances.pure = { instance }
		instance.init()
		return { instance, module }
	}
	it.each([false, true])('keeps pure fields in logic and observers but out of initial and subsequent render messages (Page: %s)', async (page) => {
		const observed = vi.fn()
		const { instance } = create({ options: { pureDataPattern: /^_/ }, data: { _cache: { n: 1 }, label: 'before' }, observers: { '_cache.**': observed } }, { page })
		expect(instance.data._cache).toEqual({ n: 1 })
		expect(sent[0].body.data).toEqual({ label: 'before' })
		instance.setData({ '_cache.n': 2, label: 'after' })
		expect(observed).toHaveBeenCalledWith({ n: 2 })
		await Promise.resolve()
		expect(sent.at(-1).body.updates[0].changes).toEqual([{ path: ['label'], value: 'after' }])
	})
	it('does not serialize or render a pure-only assignment, while preserving setData callbacks', async () => {
		const { instance } = create({ options: { pureDataPattern: /^_/ } })
		sent.length = 0
		instance.setData({ _cache: 'logic only' })
		await Promise.resolve()
		expect(sent).toEqual([])
		const callback = vi.fn()
		instance.setData({ _cache: 'with callback' }, callback)
		await Promise.resolve()
		expect(sent[0].body.updates[0]).toEqual({ moduleId: 'instance', data: {}, changes: [] })
		expect(sent[0].body.callbackIds).toHaveLength(1)
	})
	it('lets JSON configuration override JS options and sends the filter metadata with properties', () => {
		const { instance, module } = create({ options: { pureDataPattern: /^js/ }, data: { jsValue: 1, jsonValue: 2 }, properties: { jsonProp: String } }, { jsonPattern: '^json' })
		expect(instance.data).toEqual({ jsValue: 1, jsonValue: 2, jsonProp: '' })
		expect(sent[0].body.data).toEqual({ jsValue: 1 })
		expect(module.getProps().__diminaMeta.pureDataPattern).toEqual(['^json', ''])
	})
})
