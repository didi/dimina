/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, resolveDirective, withDirectives } from 'vue'
import { Components } from '../index.js'

describe('WXML style directive', () => {
	it('registers ComponentHost and keeps the legacy compiled tag as an alias', () => {
		const app = createApp({ render: () => null })
		Components(app)

		expect(app.component('dd-component-host')).toBeDefined()
		expect(app.component('dd-wrapper')).toBe(app.component('dd-component-host'))
	})

	it('updates WXML declarations without erasing component-owned inline styles', async () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const externalStyle = ref('color: red; margin: 1rpx')
		const imageUrl = ref('/first.png')

		const app = createApp({
			setup() {
				return () => withDirectives(h('div', {
					style: {
						backgroundImage: `url(${imageUrl.value})`,
						backgroundSize: 'cover',
					},
				}), [[resolveDirective('c-style'), externalStyle.value]])
			},
		})
		Components(app)
		app.mount(host)
		const element = host.firstElementChild

		expect(element.style.backgroundImage).toContain('/first.png')
		expect(element.style.backgroundSize).toBe('cover')
		expect(element.style.color).toBe('red')
		expect(element.style.margin).toBe('0.133333vw')

		imageUrl.value = '/second.png'
		externalStyle.value = 'color: blue'
		await nextTick()
		expect(element.style.backgroundImage).toContain('/second.png')
		expect(element.style.backgroundSize).toBe('cover')
		expect(element.style.color).toBe('blue')
		expect(element.style.margin).toBe('')

		externalStyle.value = ''
		await nextTick()
		expect(element.style.backgroundImage).toContain('/second.png')
		expect(element.style.backgroundSize).toBe('cover')
		expect(element.style.color).toBe('')

		app.unmount()
		host.remove()
	})
})
