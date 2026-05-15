/* eslint-disable no-extend-native */
function defineArrayMethod(name, value) {
	if (typeof Array.prototype[name] === 'function') {
		return
	}

	Object.defineProperty(Array.prototype, name, {
		value,
		configurable: true,
		writable: true,
	})
}

defineArrayMethod('toReversed', function toReversed() {
	return Array.prototype.slice.call(this).reverse()
})

defineArrayMethod('toSorted', function toSorted(compareFn) {
	return Array.prototype.slice.call(this).sort(compareFn)
})

defineArrayMethod('toSpliced', function toSpliced(...args) {
	const copy = Array.prototype.slice.call(this)
	copy.splice(...args)
	return copy
})
