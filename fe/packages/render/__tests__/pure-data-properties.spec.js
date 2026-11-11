import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, reactive, Suspense } from 'vue'
import { Module } from '../src/core/module'
import loader from '../src/core/loader'
import message from '../src/core/message'
import runtime from '../src/core/runtime'

let app
let root
afterEach(() => { app?.unmount(); root?.remove(); delete window.DiminaRenderBridge; vi.restoreAllMocks() })

it('keeps pure properties available to Service while excluding them from initial and updated template data', async () => {
	const module = new Module({ id: 'pure-props', usingComponents: {}, render() { return h('span', this.label + '|' + (this.cache || '')) } })
	module.setInitialData({ label: { type: ['s'], default: '' }, cache: { type: ['s'], default: '' }, __diminaMeta: { pureDataPattern: ['^cache$', ''] } })
	vi.spyOn(loader, 'getModuleByPath').mockReturnValue(module)
	const sent = []
	window.DiminaRenderBridge = { publish(payload) {
		const msg = JSON.parse(payload)
		sent.push(msg)
		if (msg.type === 'mC') window.DiminaRenderBridge.onMessage({ type: msg.body.moduleId, body: { data: msg.body.properties } })
	} }
	message.init()
	const Comp = runtime.createComponent('/pages/pure/index', 'pure-render', { probe: '/components/pure/index' })['dd-probe']
	const props = reactive({ label: 'visible', cache: 'secret' })
	app = createApp({ setup() {
		provide('info', { id: 'pure-page', sId: 'pure-scope' })
		provide('path', '/pages/pure/index')
		provide('/pages/pure/index', { id: 'pure-page' })
		return () => h(Suspense, null, { default: () => h(Comp, props) })
	} })
	root = document.createElement('div')
	document.body.append(root)
	app.mount(root)
	await vi.waitFor(() => expect(root.textContent).toBe('visible|'))
	const created = sent.find(msg => msg.type === 'mC')
	expect(created.body.properties.cache).toBe('secret')
	props.cache = 'updated secret'
	props.label = 'after'
	await nextTick()
	expect(root.textContent).toBe('after|')
	expect(runtime.setupData.get(created.body.moduleId)).not.toHaveProperty('cache')
	expect(sent.find(msg => msg.body?.methodName === 'tO').body.event).toEqual({ label: 'after', cache: 'updated secret' })
})
