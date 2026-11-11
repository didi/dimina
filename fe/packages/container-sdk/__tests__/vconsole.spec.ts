import { beforeEach, expect, it, vi } from 'vitest'
const { create, plugins } = vi.hoisted(() => ({ create: vi.fn(), plugins: [] as any[] }))
vi.mock('vconsole', () => {
	class Plugin {
		events: Record<string, any> = {}
		constructor(public id: string, public name: string) { plugins.push(this) }
		on(name: string, handler: any) { this.events[name] = handler; return this }
	}
	return { default: class {
		static VConsolePlugin = Plugin
		constructor() { create() }
		setSwitchPosition = vi.fn()
		addPlugin = vi.fn()
	} }
})
beforeEach(() => { vi.resetModules(); create.mockClear(); plugins.length = 0; delete window.vConsole; window.history.replaceState({}, '', '/') })
it('initializes synchronously with the native URL flag in production too', async () => {
	window.history.replaceState({}, '', '/?vconsole=1')
	await import('../src/pages/pageFrame/vconsole')
	expect(create).toHaveBeenCalledOnce(); expect(window.vConsole).toBeDefined()
	await window.__dimina_enable_vconsole__!(); expect(create).toHaveBeenCalledOnce()
})
it('does not create a console without explicit activation', async () => {
	await import('../src/pages/pageFrame/vconsole')
	expect(create).not.toHaveBeenCalled()
})
it('shows native storage values as text and allows refresh without browser storage writes', async () => {
	window.history.replaceState({}, '', '/?vconsole=1'); await import('../src/pages/pageFrame/vconsole')
	window.dispatchEvent(new Event('dimina:debug-ready'))
	const plugin = plugins.at(-1); let content: HTMLElement
	plugin.events.renderTab((element: HTMLElement) => { content = element })
	const request = vi.fn(); window.addEventListener('dimina:debug-storage-request', request)
	plugin.events.show(); expect(request).toHaveBeenCalledOnce()
	window.dispatchEvent(new CustomEvent('dimina:debug-storage', { detail: { value: [{ key: '<script>', data: 42 }] } }))
	expect(content!.querySelector('input')!.value).toBe('<script>'); expect(content!.querySelector('script')).toBeNull()
	plugin.events.remove(); window.removeEventListener('dimina:debug-storage-request', request)
})

it('edits JSON, preserves encrypted namespace, confirms deletes and reports errors', async () => {
	window.history.replaceState({}, '', '/?vconsole=1'); await import('../src/pages/pageFrame/vconsole')
	window.dispatchEvent(new Event('dimina:debug-ready'))
	const plugin = plugins.at(-1); let content!: HTMLElement
	plugin.events.renderTab((element: HTMLElement) => { content = element })
	const request = vi.fn(); window.addEventListener('dimina:debug-storage-request', request)
	const reply = (detail: any) => window.dispatchEvent(new CustomEvent('dimina:debug-storage', { detail }))
	const click = (name: string) => Array.from(content.querySelectorAll('button')).find(b => b.textContent === name)!.click()
	reply({ value: [{ key: 'secret', data: 42, encrypted: true }] })
	const value = content.querySelector('textarea')!
	value.value = 'invalid'; click('Save'); expect(request).not.toHaveBeenCalled()
	value.value = '{"n":false}'; click('Save')
	expect(request.mock.lastCall![0].detail).toEqual({ action: 'set', key: 'secret', data: { n: false }, encrypted: true })
	expect(content.querySelector('fieldset')!.disabled).toBe(true)
	reply({ error: 'setStorage:fail disk full' })
	expect(value.value).toBe('{"n":false}'); expect(content.textContent).toContain('disk full')
	expect(content.querySelector('fieldset')!.disabled).toBe(false)
	request.mockClear(); click('Delete'); expect(request).not.toHaveBeenCalled()
	click('Confirm delete')
	expect(request.mock.lastCall![0].detail).toEqual({ action: 'remove', key: 'secret', encrypted: true })
	reply({ value: [] })
	expect(content.querySelector('input')!.value).toBe('')
	content.querySelector('input')!.value = 'new'
	content.querySelector('textarea')!.value = '"text"'; click('Add')
	expect(request.mock.lastCall![0].detail).toEqual({ action: 'set', key: 'new', data: 'text', encrypted: false })
	plugin.events.remove(); window.removeEventListener('dimina:debug-storage-request', request)
})
