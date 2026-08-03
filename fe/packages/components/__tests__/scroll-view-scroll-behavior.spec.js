/** @vitest-environment jsdom */

import { createApp, h, nextTick, provide, ref } from 'vue'
import ScrollView from '../src/component/scroll-view/ScrollView.vue'

// jsdom does not implement Element#scrollTo. Stub it on the prototype before
// mounting so the onMounted initial-position call (which now goes through
// scrollTo instead of a direct property write) has something to call, and so
// the spy also captures that mount-time call.
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
const originalScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')

const mounted = []

// currentScrollTop/currentScrollLeft let a test set a non-zero "already
// scrolled to" sentinel so the fallback branch (axis not set by props) can be
// asserted to read the element's current position rather than hardcoding 0.
function mountScrollView(getProps, { currentScrollTop = 0, currentScrollLeft = 0 } = {}) {
	const scrollToSpy = vi.fn()
	Object.defineProperty(Element.prototype, 'scrollTo', {
		configurable: true,
		writable: true,
		value: scrollToSpy,
	})
	Object.defineProperty(Element.prototype, 'scrollTop', {
		configurable: true,
		writable: true,
		value: currentScrollTop,
	})
	Object.defineProperty(Element.prototype, 'scrollLeft', {
		configurable: true,
		writable: true,
		value: currentScrollLeft,
	})

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
	mounted.push({ app, host })
	app.mount(host)
	const element = host.querySelector('.dd-scroll-view')
	return { app, host, element, scrollToSpy }
}

afterEach(() => {
	let firstCleanupError
	for (const { app, host } of mounted.splice(0)) {
		try {
			app.unmount()
		}
		catch (error) {
			firstCleanupError ??= error
		}
		try {
			host.remove()
		}
		catch (error) {
			firstCleanupError ??= error
		}
	}

	for (const [prop, original] of [['scrollTo', originalScrollTo], ['scrollTop', originalScrollTop], ['scrollLeft', originalScrollLeft]]) {
		if (original) {
			Object.defineProperty(Element.prototype, prop, original)
		}
		else {
			delete Element.prototype[prop]
		}
	}

	if (firstCleanupError) throw firstCleanupError instanceof Error ? firstCleanupError : new Error(String(firstCleanupError))
})

describe('ScrollView programmatic scroll behavior', () => {
	it('jumps instantly instead of animating when scroll-with-animation is not enabled', async () => {
		const scrollTop = ref(0)
		const { scrollToSpy } = mountScrollView(() => ({ scrollY: true, scrollTop: scrollTop.value }))
		scrollToSpy.mockClear()

		scrollTop.value = 500
		await nextTick()

		expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))
	})

	it('animates when scroll-with-animation is explicitly enabled', async () => {
		const scrollTop = ref(0)
		const { scrollToSpy } = mountScrollView(() => ({ scrollY: true, scrollWithAnimation: true, scrollTop: scrollTop.value }))
		scrollToSpy.mockClear()

		scrollTop.value = 500
		await nextTick()

		expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
	})

	it('jumps instantly to the initial scroll position on mount when scroll-with-animation is not enabled', () => {
		const { scrollToSpy } = mountScrollView(() => ({
			scrollX: true,
			scrollY: true,
			scrollTop: 120,
			scrollLeft: 40,
		}))

		expect(scrollToSpy).toHaveBeenCalledTimes(1)
		expect(scrollToSpy).toHaveBeenCalledWith({ top: 120, left: 40, behavior: 'instant' })
	})

	it('animates to the initial scroll position on mount when scroll-with-animation is enabled', () => {
		const { scrollToSpy } = mountScrollView(() => ({
			scrollX: true,
			scrollY: true,
			scrollTop: 120,
			scrollLeft: 40,
			scrollWithAnimation: true,
		}))

		expect(scrollToSpy).toHaveBeenCalledTimes(1)
		expect(scrollToSpy).toHaveBeenCalledWith({ top: 120, left: 40, behavior: 'smooth' })
	})

	it('does not call scrollTo on mount when neither scroll-top nor scroll-left is set', () => {
		const { scrollToSpy } = mountScrollView(() => ({ scrollX: true, scrollY: true }))

		expect(scrollToSpy).not.toHaveBeenCalled()
	})

	it('keeps the current scroll-left when only scroll-top is set on mount', () => {
		const { scrollToSpy } = mountScrollView(
			() => ({ scrollY: true, scrollTop: 120 }),
			{ currentScrollLeft: 77 },
		)

		expect(scrollToSpy).toHaveBeenCalledTimes(1)
		expect(scrollToSpy).toHaveBeenCalledWith({ top: 120, left: 77, behavior: 'instant' })
	})

	it('keeps the current scroll-top when only scroll-left is set on mount', () => {
		const { scrollToSpy } = mountScrollView(
			() => ({ scrollX: true, scrollLeft: 40 }),
			{ currentScrollTop: 88 },
		)

		expect(scrollToSpy).toHaveBeenCalledTimes(1)
		expect(scrollToSpy).toHaveBeenCalledWith({ top: 88, left: 40, behavior: 'instant' })
	})
})
