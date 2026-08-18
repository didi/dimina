import { isFunction } from './utils'

const JSModules = {} // 缓存已定义的模块
const MODULES_STATUS_UNLOAD = 1 // 未加载
const MODULES_STATUS_LOADED = 2 // 已加载

// 模块定义函数
function modDefine(id, factory) {
	if (!JSModules[id]) {
		JSModules[id] = {
			factory,
			status: MODULES_STATUS_UNLOAD,
			exports: undefined,
		}
	}
}

function hasModule(id) {
	return Object.prototype.hasOwnProperty.call(JSModules, id)
}

// 模块加载函数
function modRequire(id, callback, errorCallback) {
	if (typeof id !== 'string') {
		throw new TypeError('require args must be a string')
	}
	const mod = JSModules[id]
	if (!mod) {
		throw new Error(`module ${id} not found`)
	}

	if (mod.status === MODULES_STATUS_UNLOAD) {
		mod.status = MODULES_STATUS_LOADED
		const module = {
			exports: {},
		}
		let res
		try {
			if (mod.factory) {
				res = mod.factory.call(null, modRequire, module, module.exports)
			}
		}
		catch (e) {
			mod.status = MODULES_STATUS_UNLOAD
			const em = `
				name: ${e.name}
				msg: ${e.message}
				stack:
				${e.stack}
			`
			console.error(`require ${id} error: ${em}`)
			if (isFunction(globalThis.__diminaReportError)) {
				globalThis.__diminaReportError(e)
			}
			if (isFunction(errorCallback)) {
				errorCallback({ mod: id, errMsg: e.message })
			}
		}
		mod.exports = module.exports === undefined ? res : module.exports
	}

	if (isFunction(callback)) {
		callback(mod.exports)
	}

	return mod.exports
}

// TODO:https://developers.weixin.qq.com/miniprogram/dev/reference/api/require.html
modRequire.async = async (id) => {
	return new Promise((resolve, reject) => {
		try {
			resolve(modRequire(id))
		}
		catch (e) {
			reject(new Error(`${e.message}: Failed to initialize asynchronous loading for module '${id}'`))
		}
	})
}

export { hasModule, modDefine, modRequire }
