import { compile } from '@dimina/compiler/browser'
globalThis.onmessage = async ({ data }) => {
	try { globalThis.postMessage({ resources: await compile(data.files, data.options) }) }
	catch (error) { globalThis.postMessage({ error: error.message }) }
}
