import { describe, expect, it } from 'vitest'
import { PageModule } from '../src/instance/page/page-module'

describe('PageModule behaviors', () => {
	it('merges behavior methods into the page root', () => {
		const pageModule = new PageModule({
			behaviors: [{
				data: {
					fromBehavior: 'behavior',
				},
				methods: {
					onShowToast() {
						return this.data.fromBehavior
					},
				},
			}],
			data: {
				fromPage: 'page',
			},
		}, {
			usingComponents: {},
		})

		expect(pageModule.moduleInfo.onShowToast).toBeTypeOf('function')
		expect(pageModule.noReferenceData).toEqual({
			fromBehavior: 'behavior',
			fromPage: 'page',
		})
	})

	it('keeps page methods higher priority than behavior methods', () => {
		const pageMethod = () => 'page'

		const pageModule = new PageModule({
			behaviors: [{
				methods: {
					onShowToast() {
						return 'behavior'
					},
				},
			}],
			onShowToast: pageMethod,
		}, {
			usingComponents: {},
		})

		expect(pageModule.moduleInfo.onShowToast).toBe(pageMethod)
	})
})
