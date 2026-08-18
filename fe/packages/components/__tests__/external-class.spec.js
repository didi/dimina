/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, provide, resolveDirective, withDirectives } from 'vue'
import { Components } from '../index.js'
import { replaceExternalClassTokens } from '../src/common/utils'

describe('replaceExternalClassTokens', () => {
	it('records bind, catch and capture listeners for custom event path reconstruction', async () => {
		const EventNode = {
			render() {
				const eventNode = resolveDirective('c-event-node')
				return withDirectives(h('div', {
					bindchange: 'onBind',
					'catch:close': 'onCatch',
					'capture-bind:change': 'onCaptureBind',
					'capture-catch:close': 'onCaptureCatch',
				}), [[eventNode, 'node']])
			},
		}
		const root = document.createElement('div')
		document.body.append(root)
		const app = createApp(EventNode)
		app.use(Components)
		app.mount(root)
		await nextTick()

		expect(root.firstElementChild._ddEventBindings).toHaveLength(1)
		expect(root.firstElementChild._ddEventBindings[0]).toMatchObject({
			nodeType: 'node',
			eventAttr: {
				change: {
					bind: 'onBind',
					captureBind: 'onCaptureBind',
				},
				close: {
					catch: 'onCatch',
					captureCatch: 'onCaptureCatch',
				},
			},
		})

		app.unmount()
		root.remove()
	})

	it('replaces external class placeholders without duplicating resolved classes', () => {
		const className = 't-image__img t-image--shape-square t-class-image dd-image'
		const replacement = 't-swiper__image-host t-swiper__image t-class-image'

		const result = replaceExternalClassTokens(className, 't-class-image', replacement)

		expect(result).toBe('t-image__img t-image--shape-square t-swiper__image-host t-swiper__image t-class-image dd-image')
	})

	it('is idempotent when external class parsing runs multiple times', () => {
		const initial = 't-image__img t-image--shape-square t-class-image dd-image'
		const replacement = 't-swiper__image-host t-swiper__image t-class-image'

		const firstPass = replaceExternalClassTokens(initial, 't-class-image', replacement)
		const secondPass = replaceExternalClassTokens(firstPass, 't-class-image', replacement)

		expect(secondPass).toBe(firstPass)
		expect(secondPass.match(/t-swiper__image-host/g)).toHaveLength(1)
		expect(secondPass.match(/t-swiper__image(?!-host)/g)).toHaveLength(1)
	})

	it('keeps unrelated classes untouched while deduplicating replacement tokens', () => {
		const className = 'foo t-class-image bar'
		const replacement = 'foo baz t-class-image baz'

		const result = replaceExternalClassTokens(className, 't-class-image', replacement)

		expect(result).toBe('foo baz t-class-image bar')
	})

	it('applies the lexical caller scope together with external class tokens', async () => {
		const ExternalImage = {
			props: {
				tClassImage: String,
			},
			setup(props, { expose }) {
				provide('externalClasses', ['t-class-image'])
				expose({
					props,
					sId: 'data-v-grid-item-scope',
				})
			},
			render() {
				const externalClass = resolveDirective('c-class')
				return withDirectives(
					h('div', { class: 't-image t-class-image' }),
					[[externalClass]],
				)
			},
		}
		const root = document.createElement('div')
		document.body.append(root)
		const app = createApp(ExternalImage, {
			tClassImage: 't-grid-item__image t-grid-item__image--middle t-class-image',
		})
		app.use(Components)
		app.mount(root)
		await nextTick()

		const image = root.querySelector('.t-image')
		expect(image.classList.contains('t-grid-item__image')).toBe(true)
		expect(image.classList.contains('t-grid-item__image--middle')).toBe(true)
		expect(image.hasAttribute('data-v-grid-item-scope')).toBe(true)
		expect(image.getAttribute('data-dd-external-class-scope')).toBe('data-v-grid-item-scope')

		app.unmount()
		root.remove()
	})
})
