import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/instance/app/app.js'

describe('App instance fields', () => {
	it('should preserve non-function fields defined on App options', () => {
		const emit = vi.fn()
		const eventBus = { emit }

		const app = new App({
			moduleInfo: {
				globalData: {},
				eventBus,
				onLaunch() {
					this.eventBus.emit('ready')
				},
			},
		}, {})

		expect(app.eventBus).toBe(eventBus)
		expect(emit).toHaveBeenCalledWith('ready')
	})
})
