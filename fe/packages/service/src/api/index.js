import { invokeAPI } from '@/api/common'

const apiInfo = import.meta.glob('./core/**/index.js', { eager: true })
const api = {}
for (const f of Object.values(apiInfo)) {
	for (const [k, v] of Object.entries(f)) {
		api[k] = v
	}
}

// 把容器/原生侧承接、core 目录里无实现的 API 名字登记成 api 上真实的
// own enumerable property，让 Object.keys(wx) 能直接枚举到它们，
// 供 Taro 等按 Object.keys(wx) 建表的框架识别。
// 撞 Object.prototype 成员（toString 等）或与已有实现重名的名字直接跳过。
export function registerEnumerableApiNames(names) {
	for (const name of names || []) {
		if (
			typeof name !== 'string'
			|| Object.prototype.hasOwnProperty.call(api, name)
			|| name in Object.prototype
		) {
			continue
		}
		Object.defineProperty(api, name, {
			value: (...args) => invokeAPI(name, ...args),
			writable: true,
			enumerable: true,
			configurable: true,
		})
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
}
/**
 * 外部挂载 API，内部转发不存在 API
 * [Render]invokeAPI -> [Container]invokeAPI -> [Service]invokeAPI -> [Container]invokeAPI
 */

const globalApi = new Proxy(api, handler)

export default globalApi
