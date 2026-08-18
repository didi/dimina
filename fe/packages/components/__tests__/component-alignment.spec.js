/** @vitest-environment jsdom */

import fs from 'node:fs'
import { resolve } from 'node:path'
import { createApp, h, nextTick, provide } from 'vue'
import Button from '../src/component/button/Button.vue'
import Camera from '../src/component/camera/Camera.vue'
import Canvas from '../src/component/canvas/Canvas.vue'
import Checkbox from '../src/component/checkbox/Checkbox.vue'
import CheckboxGroup from '../src/component/checkbox-group/CheckboxGroup.vue'
import Form from '../src/component/form/Form.vue'
import Image from '../src/component/image/Image.vue'
import Map from '../src/component/map/Map.vue'
import MovableView from '../src/component/movable-view/MovableView.vue'
import PageMeta from '../src/component/page-meta/PageMeta.vue'
import RootPortal from '../src/component/root-portal/RootPortal.vue'
import Slider from '../src/component/slider/Slider.vue'
import Swiper from '../src/component/swiper/Swiper.vue'
import SwiperItem from '../src/component/swiper-item/SwiperItem.vue'
import Video from '../src/component/video/Video.vue'
import View from '../src/component/view/View.vue'

const mounts = []

function mountComponent(component, props = {}, slots = {}) {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({
		setup() {
			provide('bridgeId', 'bridge-1')
			provide('path', 'page-path')
			provide('page-path', { id: 'module-1' })
			return () => h(component, props, slots)
		},
	})
	app.mount(host)
	const mounted = { app, host }
	mounts.push(mounted)
	return mounted
}

beforeEach(() => {
	window.__message = {
		invoke: vi.fn(),
		off: vi.fn(),
		on: vi.fn(),
		send: vi.fn(),
	}
	window.__callback = {
		remove: vi.fn(),
		store: vi.fn(() => `callback-${Math.random()}`),
	}
	window.ResizeObserver = class {
		disconnect() {}
		observe() {}
	}
})

afterEach(() => {
	while (mounts.length) {
		const { app, host } = mounts.pop()
		app.unmount()
		host.remove()
	}
	document.querySelectorAll('.portal-child').forEach(node => node.remove())
	document.documentElement.style.fontSize = ''
	document.documentElement.style.backgroundColor = ''
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('exparser component alignment', () => {
	it('clones circular swiper items through the configured Vue auto import', async () => {
		const { host } = mountComponent(Swiper, { circular: true }, {
			default: () => [
				h(SwiperItem, { itemId: 'first' }, { default: () => 'First' }),
				h(SwiperItem, { itemId: 'second' }, { default: () => 'Second' }),
			],
		})
		await nextTick()

		expect(host.querySelectorAll('[data-dd-cloned]')).toHaveLength(2)
	})

	it('changes the rem root only for packages with the vw rpx contract', () => {
		const page = document.createElement('div')
		page.className = 'dd-page'
		document.body.appendChild(page)
		document.documentElement.style.fontSize = '0.5px'

		const legacy = mountComponent(PageMeta, { rootFontSize: 'system' })
		expect(document.documentElement.style.fontSize).toBe('0.5px')
		legacy.app.unmount()
		legacy.host.remove()
		mounts.splice(mounts.indexOf(legacy), 1)

		mountComponent(PageMeta, { diminaRpxUnit: 'vw', rootFontSize: 'system' })
		expect(document.documentElement.style.fontSize).toBe('16px')
		page.remove()
	})

	it('keeps the background-image preloader in normal flow for intrinsic sizing', () => {
		const { host } = mountComponent(Image, { src: '/cover.png' })
		const preloader = host.querySelector('.dd-image-preloader')
		const imageSource = fs.readFileSync(resolve(process.cwd(), 'src/component/image/Image.vue'), 'utf8')
		const preloaderRules = imageSource.match(/\.dd-image-preloader\s*\{([^}]*)\}/)?.[1]

		expect(preloader).not.toBeNull()
		expect(preloaderRules).toContain('opacity: 0')
		expect(preloaderRules).not.toContain('position: absolute')
	})

	it('converts lazy-load screen margins to pixels before observing', async () => {
		let intersectionCallback
		const observers = []
		class IntersectionObserverMock {
			constructor(callback, options) {
				intersectionCallback = callback
				this.options = options
				this.disconnect = vi.fn()
				this.observe = vi.fn()
				observers.push(this)
			}
		}
		vi.stubGlobal('innerHeight', 800)
		vi.stubGlobal('innerWidth', 400)
		vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

		const { host } = mountComponent(Image, { lazyLoad: true, src: '/lazy.png' })
		const image = host.querySelector('img')

		expect(observers).toHaveLength(1)
		expect(observers[0].options).toEqual({ rootMargin: '1600px 800px' })
		expect(observers[0].observe).toHaveBeenCalledWith(host.querySelector('.dd-image'))
		expect(image.getAttribute('src')).toBe('')

		intersectionCallback([{ intersectionRatio: 1, isIntersecting: true }])
		await nextTick()

		expect(image.getAttribute('src')).toBe('/lazy.png')
		expect(observers[0].disconnect).toHaveBeenCalledOnce()
	})

	it('renders a real canvas with the canvas selector contract and slot overlay', () => {
		const { host } = mountComponent(Canvas, {
			canvasId: 'paint',
			renderHeight: 180,
			renderWidth: 320,
			type: '2d',
		}, { default: () => h('span', { class: 'canvas-child' }, 'overlay') })
		const canvas = host.querySelector('canvas')

		expect(canvas.getAttribute('canvas-id')).toBe('paint')
		expect(canvas.width).toBe(320)
		expect(canvas.height).toBe(180)
		expect(canvas.dataset.type).toBe('2d')
		expect(host.querySelector('.dd-canvas-slot .canvas-child')).not.toBeNull()
	})

	it('reports duplicate legacy canvas ids like exparser', async () => {
		mountComponent(Canvas, { canvasId: 'duplicate' })
		const second = mountComponent(Canvas, { binderror: 'canvasError', canvasId: 'duplicate' })
		await nextTick()

		expect(second.host.querySelector('.dd-canvas').style.display).toBe('none')
		const message = window.__message.send.mock.calls.at(-1)[0]
		expect(message.body.methodName).toBe('canvasError')
		expect(message.body.event.detail.errMsg).toContain('has already existed')
	})

	it('collects checkbox-group values and resets controls through form buttons', async () => {
		const { host } = mountComponent(Form, { bindsubmit: 'submitHandler', bindreset: 'resetHandler' }, {
			default: () => [
				h(CheckboxGroup, { name: 'roles' }, {
					default: () => [
						h(Checkbox, { value: 'admin' }, { default: () => 'Admin' }),
						h(Checkbox, { value: 'disabled', disabled: true }),
					],
				}),
				h(Button, { class: 'submit', formType: 'submit' }),
				h(Button, { class: 'reset', formType: 'reset' }),
			],
		})
		const checkboxes = host.querySelectorAll('.dd-checkbox')
		checkboxes[0].click()
		checkboxes[1].click()
		host.querySelector('.submit').click()

		let message = window.__message.send.mock.calls.at(-1)[0]
		expect(message.body.methodName).toBe('submitHandler')
		expect(message.body.event.detail.value).toEqual({ roles: ['admin'] })

		host.querySelector('.reset').click()
		await nextTick()
		expect(host.querySelector('.dd-checkbox-input-checked')).toBeNull()
		host.querySelector('.submit').click()
		message = window.__message.send.mock.calls.at(-1)[0]
		expect(message.body.event.detail.value).toEqual({ roles: [] })
	})

	it('rounds slider values relative to a non-zero minimum', () => {
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			max: 20,
			min: 10,
			step: 3,
			value: 10,
		})
		const tapArea = host.querySelector('.dd-slider-tap-area')
		tapArea.getBoundingClientRect = () => ({ left: 0, width: 100 })
		tapArea.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }))

		const message = window.__message.send.mock.calls.at(-1)[0]
		expect(message.body.methodName).toBe('changeHandler')
		expect(message.body.event.detail.value).toBe(16)
	})

	it('keeps hover class for the configured start and stay durations', async () => {
		vi.useFakeTimers()
		const { host } = mountComponent(View, {
			hoverClass: 'hovering',
			hoverStartTime: 10,
			hoverStayTime: 20,
		})
		const view = host.querySelector('.dd-view')
		view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
		vi.advanceTimersByTime(9)
		expect(view.classList.contains('hovering')).toBe(false)
		vi.advanceTimersByTime(1)
		await nextTick()
		expect(view.classList.contains('hovering')).toBe(true)
		view.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
		vi.advanceTimersByTime(19)
		await nextTick()
		expect(view.classList.contains('hovering')).toBe(true)
		vi.advanceTimersByTime(1)
		await nextTick()
		expect(view.classList.contains('hovering')).toBe(false)
	})

	it('moves root-portal content without imposing layout styles', async () => {
		const { host } = mountComponent(RootPortal, {}, {
			default: () => h('div', { class: 'portal-child' }, 'portal'),
		})
		await nextTick()

		expect(host.querySelector('.portal-child')).toBeNull()
		const child = document.documentElement.querySelector('.portal-child')
		expect(child).not.toBeNull()
		expect(child.style.position).toBe('')
		expect(child.style.zIndex).toBe('')
	})

	it('uses the local exparser defaults for native component protocols', () => {
		expect(Camera.props.filter.default).toBe(0)
		expect(Camera.props.frameSize.default).toBe('')
		expect(Camera.props.centerCrop.default).toBe(true)
		expect(Map.props.latitude.default).toBe(39.92)
		expect(Map.props.longitude.default).toBe(116.46)
		expect(Map.props.maxScale.default).toBe(22)
		expect(Map.props.enablePoi.default).toBe(true)
		expect(MovableView.props.x.default).toBe(0)
		expect(MovableView.props.y.default).toBe(0)
		expect(MovableView.props.scaleMin.default).toBe(0.5)
		expect(Video.props.direction.default).toBe(-1)
		expect(Video.props.customCache.default).toBe(true)
		expect(Video.props.seekType.default).toBe('accurate')
	})
})
