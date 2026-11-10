import { initialize, transform as wasmTransform } from 'esbuild-wasm'
import wasmURL from 'esbuild-wasm/esbuild.wasm?url&no-inline'

export const initializeTransform = () => initialize({ wasmURL, worker: false })
export const transform = (code, options) => wasmTransform(code, options)
