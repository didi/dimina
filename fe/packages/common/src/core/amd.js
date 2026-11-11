import { isFunction } from './utils'

const JSModules = Object.create(null)
const MODULES_STATUS_UNLOAD = 1
const MODULES_STATUS_LOADED = 2

function modDefine(id, factory) {
	const previous = JSModules[id]
	// WebNode keeps identical definitions cached, but replaces a changed factory.
	if (previous?.factory && previous.factory.toString() === factory?.toString()) {
		return
	}
	JSModules[id] = { factory, status: MODULES_STATUS_UNLOAD, exports: undefined }
}

function hasModule(id) {
	return Object.prototype.hasOwnProperty.call(JSModules, id)
}

function evaluateModule(id) {
	const mod = JSModules[id]
	if (!mod) {
		throw new Error(`module ${id} not found`)
	}
	if (mod.status === MODULES_STATUS_UNLOAD) {
		const module = { exports: {} }
		// Circular requires must see the initial exports object before the factory runs.
		mod.exports = module.exports
		mod.status = MODULES_STATUS_LOADED
		try {
			const factory = mod.factory
			const result = factory?.(modRequire, module, module.exports)
			mod.exports = module.exports === undefined ? result : module.exports
		}
		catch (error) {
			mod.status = MODULES_STATUS_UNLOAD
			mod.exports = undefined
			throw error
		}
	}
	return mod.exports
}

function modRequire(id, callback, errorCallback) {
	if (typeof id !== 'string') {
		throw new TypeError('require args must be a string')
	}
	if (isFunction(callback)) {
		// Callback require is asynchronous even when the module is cached.
		setTimeout(() => {
			try {
				callback(evaluateModule(id))
			}
			catch (error) {
				if (isFunction(errorCallback)) {
					errorCallback({ mod: id, errMsg: error?.message || 'async require: fail' })
				}
			}
		}, 0)
		return
	}
	return evaluateModule(id)
}

modRequire.async = id => new Promise((resolve, reject) => {
	modRequire(id, resolve, reject)
})

export { hasModule, modDefine, modRequire }
