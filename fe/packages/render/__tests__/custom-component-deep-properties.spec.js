import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, reactive, resolveComponent, Suspense, withDirectives } from 'vue'
import loader from '../src/core/loader'
import message from '../src/core/message'
import runtime from '../src/core/runtime'

describe('custom component deep property updates', () => {
	let app
	let root
	let sent
	let pendingInitialData
	const pageId = 'deep-props-page'
	const pagePath = '/pages/deep-props/index'
	const componentPath = '/components/comp'

	function observers() {
		return sent.filter(msg => msg.type === 't' && msg.body.methodName === 'tO')
	}

	async function mount({ deferInitialData = false, echoObserverData = true, outerName = 'comp', extraData = {}, scalarBindings = false } = {}) {
		const pageData = reactive({
			count: 0,
			flag: 0,
			counter: { value: 2, label: 'before' },
			i: { cn: [{ cn: [{ v: 'No record' }] }], ...extraData },
		})
		runtime.setupData.set(pageId, pageData)
		runtime.initializedModules.add(pageId)
		vi.spyOn(loader, 'getModuleByPath').mockReturnValue({
			moduleInfo: {
				id: 'deep-props-comp',
				usingComponents: { comp: componentPath },
				render() {
					const Comp = resolveComponent('dd-comp')
					return h('section', this.i.cn.map((child, index) => child.cn
						? h(Comp, { key: index, i: child })
						: h('span', { key: index }, child.v)))
				},
			},
			propertySchemas: {
				i: { type: Object, optionalTypes: [], value: null },
				flag: { type: Number, optionalTypes: [], value: 0 },
				...(scalarBindings ? {
					parity: { type: Number, optionalTypes: [], value: 0 },
					other: { type: Number, optionalTypes: [], value: 0 },
				} : {}),
			},
			props: { i: { type: null }, flag: { type: null }, ...(scalarBindings ? { parity: { type: null }, other: { type: null } } : {}) },
		})
		window.DiminaRenderBridge = {
			publish: vi.fn((payload) => {
				const msg = JSON.parse(payload)
				sent.push(msg)
				if (msg.type === 'mC') {
					const reply = () => window.DiminaRenderBridge.onMessage({
						type: msg.body.moduleId,
						body: { data: JSON.parse(JSON.stringify(msg.body.properties)) },
					})
					if (deferInitialData) pendingInitialData.push(reply)
					else reply()
				}
				else if (echoObserverData && msg.type === 't' && msg.body.methodName === 'tO') {
					// Model the Service property update reply using detached bridge data.
					runtime.updateModule({ moduleId: msg.body.moduleId, data: JSON.parse(JSON.stringify(msg.body.event)) })
				}
			}),
		}
		message.init()
		const Comp = runtime.createComponent(pagePath, 'deep-props-bridge', {
			[outerName]: outerName === 'comp' ? componentPath : '/components/custom-wrapper',
		})[`dd-${outerName}`]
		const bindingDirective = { mounted(el, binding) { el._propBindings = binding.value } }
		const bindings = {
			flag: { expression: 'counter.value' },
			parity: { expression: 'counter.value % 2', dependencyPaths: [['counter', 'value']] },
			other: { expression: 'flag' },
		}
		app = createApp({
			setup() {
				provide('info', { id: pageId, sId: 'deep-props-scope' })
				provide('path', pagePath)
				provide(pagePath, { id: pageId })
				return () => h('main', [
					h('b', String(pageData.count)),
					h(Suspense, null, {
					default: () => scalarBindings
						? withDirectives(h(Comp, {
							i: pageData.i,
							flag: pageData.counter.value,
							parity: pageData.counter.value % 2,
							other: pageData.flag,
						}), [[bindingDirective, bindings]])
						: h(Comp, { i: pageData.i, flag: pageData.flag }),
				}),
				])
			},
		})
		app.directive('c-prop-bindings', bindingDirective)
		root = document.createElement('div')
		document.body.append(root)
		app.mount(root)
		if (!deferInitialData) {
			await vi.waitFor(() => expect(root.textContent).toBe('0No record'))
		}
		return pageData
	}

	function update(path, value, moduleId = pageId) {
		runtime.updateModule({ moduleId, data: {}, changes: [{ path, value }] })
	}

	beforeEach(() => {
		sent = []
		pendingInitialData = []
	})

	afterEach(() => {
		app?.unmount()
		runtime.setupData.delete(pageId)
		runtime.initializedModules.delete(pageId)
		runtime.preInitUpdates.delete(pageId)
		root?.remove()
		delete window.DiminaRenderBridge
		vi.restoreAllMocks()
	})

	it.each(['comp', 'custom-wrapper'])('updates cards across %s and recursive comp boundaries without replacing the root property', async (outerName) => {
		const pageData = await mount({ outerName })
		const original = pageData.i
		update(['count'], 10)
		update(['i', 'cn', 0, 'cn'], [{ v: 'Activity card' }])
		await nextTick()
		expect(pageData.i).toBe(original)
		expect(root.textContent).toBe('10Activity card')
		expect(observers()).toHaveLength(2)
		expect(observers().every(msg => Object.keys(msg.body.event).join() === 'i')).toBe(true)
	})

	it('tracks nested array insertion, removal, clearing and replacement', async () => {
		await mount()
		update(['i', 'cn', 0, 'cn', 1], { v: 'Second card' })
		await nextTick()
		expect(root.textContent).toBe('0No recordSecond card')
		update(['i', 'cn', 0, 'cn', 'length'], 1)
		await nextTick()
		expect(root.textContent).toBe('0No record')
		update(['i', 'cn', 0, 'cn'], [])
		await nextTick()
		expect(root.textContent).toBe('0')
		update(['i', 'cn', 0, 'cn'], [{ v: 'Reloaded' }])
		await nextTick()
		expect(root.textContent).toBe('0Reloaded')
		expect(observers()).toHaveLength(8)
	})

	it('tracks nested field addition and deletion', async () => {
		const pageData = await mount()
		update(['i', 'cn', 0, 'cn', 0, 'selected'], true)
		await nextTick()
		expect(observers()).toHaveLength(2)
		expect(observers()[1].body.event.i.cn[0].selected).toBe(true)
		delete pageData.i.cn[0].cn[0].selected
		await nextTick()
		expect(observers()).toHaveLength(4)
		expect(observers()[3].body.event.i.cn[0]).not.toHaveProperty('selected')
	})

	it('does not send a property update on initialization', async () => {
		await mount()
		expect(observers()).toHaveLength(0)
	})

	it.each(['object replacement', 'same object assignment', 'same leaf assignment'])(
		'synchronizes an explicit %s even when the object contents are equal',
		async (assignment) => {
			const pageData = await mount()
			if (assignment === 'object replacement') {
				update(['i'], JSON.parse(JSON.stringify(pageData.i)))
			}
			else if (assignment === 'same object assignment') {
				update(['i'], pageData.i)
			}
			else {
				update(['i', 'cn', 0, 'cn', 0, 'v'], 'No record')
			}
			await nextTick()

			expect(observers().map(msg => msg.body.event)).toEqual([
				{ i: pageData.i },
				{ i: pageData.i.cn[0] },
			])
		},
	)

	it('batches simultaneous property changes in the observer message', async () => {
		const pageData = await mount()
		update(['flag'], 1)
		await nextTick()
		expect(observers().map(msg => msg.body.event)).toEqual([{ flag: 1 }])
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'Changed')
		update(['flag'], 2)
		await nextTick()
		expect(root.textContent).toBe('0Changed')
		expect(observers()[1].body.event).toEqual({ i: pageData.i, flag: 2 })
		expect(observers()[2].body.event).toEqual({ i: pageData.i.cn[0] })
	})

	it.each([false, true])('does not traverse an unchanged object prop during scalar assignment (fallback: %s)', async (scalarBindings) => {
		const read = vi.fn(() => 'unchanged')
		await mount({ scalarBindings, extraData: { details: { get label() { return read() } } } })
		expect(read).toHaveBeenCalled()
		read.mockClear()

		update(scalarBindings ? ['counter', 'value'] : ['flag'], scalarBindings ? 2 : 1)
		await nextTick()

		expect(read).not.toHaveBeenCalled()
		if (scalarBindings) {
			expect(assignedEvents()).toHaveLength(1)
		}
		else {
			expect(observers().map(msg => msg.body.event)).toEqual([{ flag: 1 }])
		}
	})

	function assignedEvents() {
		return sent.filter(msg => msg.body?.methodName === 'tOAssigned').map(msg => msg.body.event)
	}

	it('only dispatches scalar assignments for overlapping template dependencies', async () => {
		await mount({ scalarBindings: true })
		update(['counter', 'label'], 'after')
		update(['count'], 1)
		await nextTick()
		expect(assignedEvents()).toEqual([])

		update(['counter'], { value: 2, label: 'replacement' })
		await nextTick()
		expect(assignedEvents()).toEqual([{ data: { flag: 2, parity: 0 }, assigned: ['flag', 'parity'] }])
		expect(observers()).toHaveLength(0)
	})

	it('combines equal and changed scalar properties in one observer event', async () => {
		await mount({ scalarBindings: true })
		runtime.updateModule({
			moduleId: pageId,
			data: {},
			changes: [{ path: ['counter', 'value'], value: 2 }, { path: ['flag'], value: 1 }],
		})
		await nextTick()

		expect(assignedEvents()).toEqual([{
			data: { flag: 2, parity: 0, other: 1 },
			assigned: ['flag', 'parity', 'other'],
		}])
		expect(observers()).toHaveLength(0)
	})

	it('preserves separate equal assignments and skips those already observed in Service', async () => {
		await mount({ scalarBindings: true })
		const childId = sent.find(msg => msg.type === 'mC').body.moduleId
		runtime.updateModules({ updates: [{
			moduleId: pageId,
			data: {},
			changes: Array.from({ length: 3 }, () => ({ path: ['counter', 'value'], value: 2 })),
			propertyAssignments: [[0, 1, { [childId]: ['flag', 'parity'] }], [1, 2, {}], [2, 3, {}]],
		}] })
		await nextTick()

		expect(assignedEvents()).toEqual(Array.from({ length: 2 }, () => ({
			data: { flag: 2, parity: 0 },
			assigned: ['flag', 'parity'],
		})))
		expect(observers()).toHaveLength(0)
	})

	it('keeps an equal and a changed property in their original assignment group', async () => {
		await mount({ scalarBindings: true })
		runtime.updateModules({ updates: [{
			moduleId: pageId,
			data: {},
			changes: [
				{ path: ['counter', 'value'], value: 2 },
				{ path: ['flag'], value: 1 },
				{ path: ['counter', 'value'], value: 2 },
			],
			propertyAssignments: [[0, 2, {}], [2, 3, {}]],
		}] })
		await nextTick()

		expect(assignedEvents()).toEqual([
			{ data: { flag: 2, parity: 0, other: 1 }, assigned: ['flag', 'parity', 'other'] },
			{ data: { flag: 2, parity: 0 }, assigned: ['flag', 'parity'] },
		])
	})

	it('preserves a direct scalar assignment followed by an equal assignment in the same bridge batch', async () => {
		await mount({ scalarBindings: true })
		runtime.updateModules({ updates: [{
			moduleId: pageId,
			data: {},
			changes: Array.from({ length: 2 }, () => ({ path: ['counter', 'value'], value: 4 })),
			propertyAssignments: [[0, 1], [1, 2]],
		}] })
		await nextTick()
		expect(assignedEvents()).toEqual(Array.from({ length: 2 }, () => ({
			data: { flag: 4, parity: 0 },
			assigned: ['flag', 'parity'],
		})))
	})

	it('keeps parent properties and the comparison snapshot isolated from child setData', async () => {
		const pageData = await mount({ echoObserverData: false })
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'First update')
		await nextTick()
		const topId = sent.find(msg => msg.type === 'mC').body.moduleId
		// This value will also be the next parent value. A shared comparison
		// snapshot would suppress that next parent update as already equal.
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'Next update', topId)
		await nextTick()
		expect(pageData.i.cn[0].cn[0].v).toBe('First update')
		expect(observers()).toHaveLength(3)
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'Next update')
		await nextTick()
		const parentUpdates = observers().slice(3)
		expect(parentUpdates).toHaveLength(2)
		expect(parentUpdates[0].body.moduleId).toBe(topId)
		expect(parentUpdates[0].body.event).toEqual({ i: pageData.i })
		expect(parentUpdates[1].body.event).toEqual({ i: pageData.i.cn[0] })
	})

	it.each([true, false])('retains deep updates before initial Service data (echo: %s)', async (echoObserverData) => {
		await mount({ deferInitialData: true, echoObserverData })
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'Ready before init')
		await nextTick()
		expect(observers()).toHaveLength(1)
		pendingInitialData.shift()()
		await vi.waitFor(() => expect(pendingInitialData).toHaveLength(1))
		pendingInitialData.shift()()
		await vi.waitFor(() => expect(root.textContent).toBe('0Ready before init'))
	})

	it('stops old watchers on unmount and initializes fresh component instances on reentry', async () => {
		const oldPageData = await mount()
		const oldIds = sent.filter(msg => msg.type === 'mC').map(msg => msg.body.moduleId)
		app.unmount()
		root.remove()
		oldPageData.i.cn[0].cn[0].v = 'Detached'
		await nextTick()
		expect(observers()).toHaveLength(0)
		await mount()
		update(['i', 'cn', 0, 'cn', 0, 'v'], 'Reentered')
		await nextTick()
		expect(root.textContent).toBe('0Reentered')
		expect(observers()).toHaveLength(2)
		expect(observers().some(msg => oldIds.includes(msg.body.moduleId))).toBe(false)
	})
})
