/** @vitest-environment jsdom */

import { createApp, h, nextTick, provide, ref } from 'vue'
import ScrollView from '../src/component/scroll-view/ScrollView.vue'

function mountScrollView(getProps) {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({
		setup() {
			provide('bridgeId', 'bridge-1')
			provide('path', 'page-path')
			provide('page-path', { id: 'module-1' })
			return () => h(ScrollView, getProps())
		},
	})
	app.mount(host)
	const element = host.querySelector('.dd-scroll-view')
	// jsdom does not implement Element#scrollTo; stub it so scrollTo calls
	// resolve instead of throwing, and so vi.spyOn has a property to wrap.
	element.scrollTo = () => {}
	return { app, host, element }
}

describe('ScrollView programmatic scroll behavior', () => {
	it('jumps instantly instead of animating when scroll-with-animation is not enabled', async () => {
		const scrollTop = ref(0)
		const { app, host, element } = mountScrollView(() => ({ scrollY: true, scrollTop: scrollTop.value }))
		const scrollToSpy = vi.spyOn(element, 'scrollTo')

		scrollTop.value = 500
		await nextTick()

		expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))

		app.unmount()
		host.remove()
	})

	it('animates when scroll-with-animation is explicitly enabled', async () => {
		const scrollTop = ref(0)
		const { app, host, element } = mountScrollView(() => ({ scrollY: true, scrollWithAnimation: true, scrollTop: scrollTop.value }))
		const scrollToSpy = vi.spyOn(element, 'scrollTo')

		scrollTop.value = 500
		await nextTick()

		expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))

		app.unmount()
		host.remove()
	})
})
