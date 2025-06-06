const apiInfo = import.meta.glob('./core/**/index.js', { eager: true })
const api = {}
for (const f of Object.values(apiInfo)) {
	for (const [k, v] of Object.entries(f)) {
		api[k] = v
	}
}
const handler = {
	get(target, prop, receiver) {
		const origMethod = Reflect.get(target, prop, receiver)

		return origMethod
	},
}
/**
 * 外部挂载 API，内部转发不存在 API
 * [Render]invokeAPI -> [Container]invokeAPI -> [Service]invokeAPI -> [Container]invokeAPI
 */

const globalApi = new Proxy(api, handler)

export default globalApi
