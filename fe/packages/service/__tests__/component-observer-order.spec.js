import { describe, expect, it, vi } from 'vitest'
import { Component } from '../src/instance/component/component'

describe('Component.tO observer ordering', () => {
	it('executes property observers in reverse batch order after raw observers', () => {
		const calls = []
		const instance = {
			data: {
				show: false,
				position: 'center',
				name: 'fade',
			},
			__pendingSyncedProps__: {},
			__info__: {
				observers: {
					'show': () => {
						calls.push('observers:show')
					},
				},
				properties: {
					show: {
						observer: 'observeShow',
					},
					position: {
						observer: 'observeClass',
					},
				},
			},
			observeClass: vi.fn(function observeClass() {
				this.data.name = this.data.position
				calls.push(`observeClass:${this.data.name}`)
			}),
			observeShow: vi.fn(function observeShow() {
				calls.push(`observeShow:${this.data.name}`)
			}),
		}

		Component.prototype.tO.call(instance, {
			show: true,
			position: 'top',
		})

		expect(calls).toEqual([
			'observers:show',
			'observeClass:top',
			'observeShow:top',
		])
	})

	it('skips duplicate observer execution for identical render replay after parent sync', () => {
		const observeShow = vi.fn()
		const instance = {
			data: {
				show: true,
			},
			__pendingSyncedProps__: {
				show: true,
			},
			__info__: {
				observers: {},
				properties: {
					show: {
						observer: 'observeShow',
					},
				},
			},
			observeShow,
		}

		Component.prototype.tO.call(instance, {
			show: true,
		})

		expect(observeShow).not.toHaveBeenCalled()
		expect(instance.__pendingSyncedProps__).toEqual({})
		expect(instance.data.show).toBe(true)
	})
})
