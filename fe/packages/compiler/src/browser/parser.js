import { createInstance } from '@oxc-parser/binding-wasm32-wasip1/workerd'
import { wrap } from 'oxc-parser/src-js/wrap'
import wasmURL from '@oxc-parser/binding-wasm32-wasip1/wasm?url&no-inline'

let instance
export async function initializeParser() {
	const response = await fetch(wasmURL)
	if (!response.ok) throw new Error(`Unable to load parser: ${response.status}`)
	instance = await createInstance(await WebAssembly.compile(await response.arrayBuffer()))
}
export function parseSync(filename, code, options) {
	const result = wrap(instance.exports.parseSync(filename, code, options))
	if (result.errors?.length) throw new Error(`${filename}: ${result.errors[0].message}`)
	return result
}
