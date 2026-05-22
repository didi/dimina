import { invokeAPI } from '@/api/common'

const apiInfo = import.meta.glob('./core/**/index.js', { eager: true })
const api = {}
for (const f of Object.values(apiInfo)) {
	for (const [k, v] of Object.entries(f)) {
		api[k] = v
	}
}

// 登记一批由容器/原生侧承接、core 目录里无实现的 API 名字。
// get 拦截器本就把未知名字转发给 invokeAPI，故它们一直可调用；
// 下面三个拦截器再让它们可枚举、可被 in 命中，
// 使按 Object.keys(wx) 建表的框架（如 Taro）也能识别。
// 与 Object.prototype 成员（toString 等）重名的登记名会被忽略。
const enumerableApiNames = new Set()

export function setEnumerableApiNames(names) {
	for (const name of names || []) {
		// 撞 Object.prototype 成员的名字直接忽略：get 拦截器会沿原型链
		// 返回内置实现而非转发函数，登记它只会造成枚举与取值不一致。
		if (typeof name === 'string' && !(name in Object.prototype)) {
			enumerableApiNames.add(name)
		}
	}
}

const handler = {
	get(target, prop, receiver) {
		const origMethod = Reflect.get(target, prop, receiver)

		// API存在则直接调用，API 已具体实现
		if (typeof origMethod === 'function') {
			return origMethod
		}

		// 如果是非函数属性且已存在，或者特殊处理 webpackJsonp 属性来兼容 Taro，直接返回
		if (origMethod !== undefined || prop === 'webpackJsonp') {
			return origMethod
		}

		// API 不存在则返回一个函数，通过消息通道调用
		return (...args) => {
			return invokeAPI(prop, ...args)
		}
	},
	set(target, prop, value, receiver) {
		// 允许对target对象进行属性赋值
		return Reflect.set(target, prop, value, receiver)
	},
	has(target, prop) {
		if (Reflect.has(target, prop)) {
			return true
		}
		// 仅当 target 仍可扩展时才暴露这些虚拟名字；对象冻结后保持与自身属性一致
		return Reflect.isExtensible(target)
			&& typeof prop === 'string'
			&& enumerableApiNames.has(prop)
	},
	ownKeys(target) {
		const keys = Reflect.ownKeys(target)
		// target 不可扩展时，ownKeys 必须只返回它自身的 key（Proxy 不变量要求）
		if (!Reflect.isExtensible(target)) {
			return keys
		}
		for (const name of enumerableApiNames) {
			if (!Object.prototype.hasOwnProperty.call(target, name)) {
				keys.push(name)
			}
		}
		return keys
	},
	getOwnPropertyDescriptor(target, prop) {
		const desc = Reflect.getOwnPropertyDescriptor(target, prop)
		if (desc !== undefined) {
			return desc
		}
		if (Reflect.isExtensible(target)
			&& typeof prop === 'string'
			&& enumerableApiNames.has(prop)) {
			return {
				value: (...args) => invokeAPI(prop, ...args),
				writable: true,
				enumerable: true,
				configurable: true,
			}
		}
		return undefined
	},
}
/**
 * 外部挂载 API，内部转发不存在 API
 * [Render]invokeAPI -> [Container]invokeAPI -> [Service]invokeAPI -> [Container]invokeAPI
 */

const globalApi = new Proxy(api, handler)

export default globalApi
