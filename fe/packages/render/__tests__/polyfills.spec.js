/* eslint-disable no-extend-native */
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalDescriptors = {
	toReversed: Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed'),
	toSorted: Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted'),
	toSpliced: Object.getOwnPropertyDescriptor(Array.prototype, 'toSpliced'),
}

function restoreArrayMethod(name) {
	const descriptor = originalDescriptors[name]

	if (descriptor) {
		Object.defineProperty(Array.prototype, name, descriptor)
	} else {
		delete Array.prototype[name]
	}
}

function removeArrayMethod(name) {
	delete Array.prototype[name]
}

async function loadPolyfills() {
	vi.resetModules()
	await import('../src/polyfills.js')
}

afterEach(() => {
	restoreArrayMethod('toReversed')
	restoreArrayMethod('toSorted')
	restoreArrayMethod('toSpliced')
	vi.resetModules()
})

describe('render polyfills', () => {
	it('defines ES2023 array copy methods when they are missing', async () => {
		removeArrayMethod('toReversed')
		removeArrayMethod('toSorted')
		removeArrayMethod('toSpliced')

		await loadPolyfills()

		const values = [3, 1, 2]

		expect(values.toReversed()).toEqual([2, 1, 3])
		expect(values.toSorted()).toEqual([1, 2, 3])
		expect(values.toSpliced(1, 1, 4)).toEqual([3, 4, 2])
		expect(values).toEqual([3, 1, 2])

		expect(Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed').enumerable).toBe(false)
	})

	it('keeps existing native implementations', async () => {
		function nativeMethod() {
			return ['native']
		}

		Object.defineProperty(Array.prototype, 'toReversed', {
			value: nativeMethod,
			configurable: true,
			writable: true,
		})

		await loadPolyfills()

		expect(Array.prototype.toReversed).toBe(nativeMethod)
	})
})
