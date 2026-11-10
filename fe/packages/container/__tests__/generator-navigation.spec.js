// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeneratorNavigation } from '../src/generatorNavigation.js'

afterEach(() => document.body.replaceChildren())
function setup(load) {
	document.body.innerHTML = '<div id="root"><main class="device-stage"><button data-demo-mode="examples"></button><button data-demo-mode="generator"></button><section class="device-stage__statement"></section><section class="device-stage__workspace" hidden></section><div class="iphone__apps"><div id="examples"></div></div></main></div>'
	const application = { el: document.getElementById('examples'), sleepActiveView: vi.fn(), wakeActiveView: vi.fn() }
	const device = { root: document.getElementById('root'), appContainer: document.querySelector('.iphone__apps'), open: vi.fn(), updateStatusBarColor: vi.fn() }
	const navigation = createGeneratorNavigation({ device, container: { application }, load })
	return { navigation, application, device }
}

describe('integrated generator navigation', () => {
	it('reuses the device and workspace, preserves examples, and closes generated execution when leaving', async () => {
		const workspace = { show: vi.fn(), hide: vi.fn() }
		const mountGenerator = vi.fn(() => workspace)
		const load = vi.fn(async () => ({ mountGenerator }))
		const { navigation, application, device } = setup(load)
		await navigation.open('generator', 'local-app')
		expect(application.el.hidden).toBe(true)
		expect(application.sleepActiveView).toHaveBeenCalledOnce()
		expect(workspace.show).toHaveBeenCalledWith('local-app')
		expect(device.appContainer.querySelectorAll('#preview')).toHaveLength(1)
		await navigation.open('examples')
		expect(workspace.hide).toHaveBeenCalledOnce()
		expect(application.el.hidden).toBe(false)
		expect(application.wakeActiveView).toHaveBeenCalledOnce()
		expect(device.open).toHaveBeenLastCalledWith(application)
		await navigation.open('generator')
		expect(load).toHaveBeenCalledOnce()
		expect(mountGenerator).toHaveBeenCalledOnce()
	})

	it('does not mount a late-loaded workspace after the user returns to examples', async () => {
		let resolve
		const mountGenerator = vi.fn()
		const load = () => new Promise(done => { resolve = done })
		const { navigation, application } = setup(load)
		const opening = navigation.open('generator')
		await navigation.open('examples')
		resolve({ mountGenerator })
		await opening
		expect(mountGenerator).not.toHaveBeenCalled()
		expect(application.el.hidden).toBe(false)
	})
})
