import CompilerWorker from './compiler.worker.js?worker'
import { createGenerator as createGeneration } from './generation.js'
import { validateFiles } from './protocol.js'
export { createHttpProvider } from './provider.js'
export { createSourceArchive, readSourceProject } from './archive.js'
export { createProjectStore } from './store.js'
import { createPreview as createRuntimePreview } from './preview.js'
import sandboxSource from '../.runtime/sandbox.js?raw'
export function createPreview(options) {
	return createRuntimePreview({ ...options, runtimeSource: sandboxSource })
}
export { parseProject, validateFiles } from './protocol.js'

export function compileProject(files, options = {}, { signal, timeout = 60000 } = {}) {
	validateFiles(files)
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return }
		const worker = new CompilerWorker()
		const done = (error, result) => {
			clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort)
			error ? reject(error) : resolve(result)
		}
		const abort = () => done(new DOMException('已取消', 'AbortError'))
		const timer = setTimeout(() => done(new Error('本地编译超时')), timeout)
		signal?.addEventListener('abort', abort, { once: true })
		worker.onmessage = ({ data }) => data.error ? done(new Error(data.error)) : done(null, data.resources)
		worker.onerror = event => done(new Error(event.message || '编译 Worker 启动失败'))
		worker.postMessage({ files, options })
	})
}


export function createGenerator(options) {
	return createGeneration({ compile: compileProject, ...options })
}
