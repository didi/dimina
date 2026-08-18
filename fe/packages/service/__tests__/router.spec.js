import { afterEach, describe, expect, it, vi } from 'vitest'
import { extBridge } from '../src/api/core/ext'
import { PageModule } from '../src/instance/page/page-module'
import router from '../src/core/router'
import runtime from '../src/core/runtime'

describe('router page removal', () => {
	const stackId = 'late-page-unload'
	const oldBridgeId = 'bridge-old'
	const currentBridgeId = 'bridge-current'

	afterEach(() => {
		delete runtime.instances[oldBridgeId]
		router.remove(oldBridgeId)
		router.remove(currentBridgeId)
		router.popStack(stackId)
	})

	it('keeps the current page when an older page unload arrives late', () => {
		const pageUnload = vi.fn()
		router.pushStack(stackId)
		router.push({ id: oldBridgeId }, stackId)
		router.push({ id: currentBridgeId }, stackId)
		runtime.instances[oldBridgeId] = {
			'page-old': {
				__id__: 'page-old',
				__type__: PageModule.type,
				pageUnload,
			},
		}

		runtime.pageUnload({ bridgeId: oldBridgeId })

		expect(pageUnload).toHaveBeenCalledOnce()
		expect(router.getPageInfo().id).toBe(currentBridgeId)

		globalThis.DiminaServiceBridge.invoke = vi.fn()
		extBridge({ module: 'TestHostModule', event: 'hello' })
		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({ bridgeId: currentBridgeId }),
		}))
	})
})
