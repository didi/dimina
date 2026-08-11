import { invokeAPI } from '@/api/common'

const apiInfo = import.meta.glob('./core/**/index.js', { eager: true })
const api = {}
// 这些名字曾由 WebSocket/EventEmitter 式实现暴露，但不属于微信公开 API。native 仍保留
// offSocket* 作为脚本层注册失败时的内部回滚桥，不能因此把它们重新登记到 wx 上。
const blockedPublicApiNames = new Set([
	'SocketTask',
	'readyState',
	'offSocketOpen',
	'offSocketMessage',
	'offSocketError',
	'offSocketClose',
])
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
			|| blockedPublicApiNames.has(name)
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
		if (blockedPublicApiNames.has(prop)) {
			return undefined
		}
		const origMethod = Reflect.get(target, prop, receiver)

		// API存在则直接调用，API 已具体实现
		if (typeof origMethod === 'function') {
			return origMethod
		}

		// 未实现且未由 native 注册的名字必须保持 undefined。以前这里为任意属性动态造
		// invokeAPI 函数，导致 wx.foo、wx.SocketTask、wx.readyState 等不存在的 API 看起来
		// 全都存在；宿主扩展现在必须通过 registerEnumerableApiNames 明确登记。
		return origMethod
	},
	set(target, prop, value, receiver) {
		// 允许对target对象进行属性赋值
		return Reflect.set(target, prop, value, receiver)
	},
}
/**
 * 外部挂载 API；宿主扩展 API 需先通过 registerEnumerableApiNames 登记
 * [Render]invokeAPI -> [Container]invokeAPI -> [Service]invokeAPI -> [Container]invokeAPI
 */

const globalApi = new Proxy(api, handler)

export default globalApi
