function assert(value, message) { if (!value) throw new Error(message) }

const module = new WXWebAssembly.Module(new Uint8Array(globalThis.__fixtureBytes))
const transferMethods = ['transfer', 'transferToFixedLength'].filter(name => typeof ArrayBuffer.prototype[name] === 'function')
assert(transferMethods.includes('transfer'), 'ArrayBuffer transfer is available')

// Ordinary buffers must retain the engine's transfer behavior.
for (const name of transferMethods) {
	const ordinary = new Uint8Array([3, 8, 21]).buffer
	assert(WXWebAssembly.validate(ordinary) === false, 'Validation accepts ordinary bytes without locking their backing store')
	const result = ArrayBuffer.prototype[name].call(ordinary, 5)
	assert(ordinary.byteLength === 0, `${name} detaches an ordinary buffer`)
	assert(result.byteLength === 5 && new Uint8Array(result)[2] === 21 && new Uint8Array(result)[4] === 0, `${name} preserves ordinary buffer bytes`)
}

const prototypeHas = WeakSet.prototype.has
const prototypeAdd = WeakSet.prototype.add
try {
	// Application prototype changes must not remove the native ownership guard.
	WeakSet.prototype.has = () => false
	WeakSet.prototype.add = function () { return this }
	const instance = new WXWebAssembly.Instance(module, { host: { callback: n => n } })
	const memory = instance.exports.memory

	function checkProtected(buffer, phase) {
		const size = buffer.byteLength
		for (const name of transferMethods) {
			const method = ArrayBuffer.prototype[name]
			const calls = [
				['direct', () => buffer[name]()],
				['prototype', () => method.call(buffer)],
				['Reflect', () => Reflect.apply(method, buffer, [0])],
			]
			for (const [route, invoke] of calls) {
				let rejected = false
				try { invoke() } catch (error) { rejected = error instanceof TypeError }
				assert(rejected, `Wasm buffer ${phase} ${route} ${name} must throw TypeError`)
				assert(buffer.byteLength === size, `Rejected ${name} keeps the Wasm buffer attached`)
			}
		}
	}

	const initial = memory.buffer
	checkProtected(initial, 'initial')
	new Int32Array(initial)[0] = 123456
	assert(instance.exports.read(0) === 123456, 'Rejected transfers preserve live JS writes')
	Object.defineProperty(initial, 'constructor', {
		configurable: true,
		get() { throw new Error('Wasm input snapshots must not consult ArrayBuffer species') },
	})
	assert(WXWebAssembly.validate(initial) === false, 'Validation accepts Wasm memory bytes without locking their backing store')
	let invalidModule = false
	try { new WXWebAssembly.Module(initial) } catch (error) { invalidModule = error instanceof WXWebAssembly.CompileError }
	assert(invalidModule, 'Compilation rejects invalid Wasm memory bytes without locking their backing store')
	delete initial.constructor
	const copy = initial.slice(0, 4)
	assert(new Int32Array(copy)[0] === 123456, 'Wasm buffer slice remains available')
	assert(memory.grow(1) === 1, 'Protected memory grows')
	assert(initial.byteLength === 0, 'Growth still detaches the protected old buffer')
	const grown = memory.buffer
	assert(grown.byteLength === 131072 && new Int32Array(grown)[0] === 123456, 'Growth preserves live memory bytes')
	checkProtected(grown, 'grown')
	assert(memory.grow(0) === 2, 'Zero growth remains available')
	assert(grown.byteLength === 0, 'Zero growth detaches the protected old buffer')
	const current = memory.buffer
	checkProtected(current, 'after zero growth')
	instance.exports.write(4, 5678)
	assert(new Int32Array(current)[1] === 5678, 'Rejected transfers preserve live Wasm writes')
	globalThis.__teardownBuffers = [current]
} finally {
	WeakSet.prototype.has = prototypeHas
	WeakSet.prototype.add = prototypeAdd
}
