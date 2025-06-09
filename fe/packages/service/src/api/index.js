const apiInfo = import.meta.glob('./core/**/index.js', { eager: true })
const globalApi = {}
for (const f of Object.values(apiInfo)) {
	for (const [k, v] of Object.entries(f)) {
		globalApi[k] = v
	}
}
export default globalApi
