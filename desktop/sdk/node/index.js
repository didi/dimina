import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isAbsolute } from 'node:path'

import { DiminaWindow } from './window.js'
export { DiminaWindow } from './window.js'

/** Call from Node.js or Electron's main process, never expose the host to a renderer. */
export class Dimina {
  #process
  #base
  #token
  #stopped = false
  #exit
  #disposal
  #apis = new Map()
  #calls = new Map()

  static async start(options) {
    for (const name of ['runtimePath', 'packagesDir', 'dataDir']) {
      if (!isAbsolute(options[name] || '')) throw new Error(`${name} must be an absolute path`)
    }
    const child = spawn(options.runtimePath, ['--sdk-host', '--packages-dir', options.packagesDir, '--data-dir', options.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const host = new Dimina()
    host.#process = child
    child.stdin.on('error', () => {})
    host.#exit = new Promise(resolve => child.once('exit', resolve))
    child.once('exit', () => {
      host.#stopped = true
      for (const controller of host.#calls.values()) controller.abort()
      host.#calls.clear()
    })
    let diagnostics = ''
    child.stderr.on('data', bytes => {
      diagnostics = (diagnostics + bytes).slice(-4096)
      try { options.onLog?.(String(bytes)) } catch { /* Logging is an optional host hook. */ }
    })
    const lines = createInterface({ input: child.stdout })
    try {
      const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Dimina runtime startup timed out')), options.startupTimeoutMs ?? 30000)
        const error = value => { clearTimeout(timer); reject(value) }
        child.once('error', error)
        child.once('exit', code => error(new Error(`Dimina runtime exited (${code}): ${diagnostics}`)))
        lines.once('line', line => {
          clearTimeout(timer)
          try { resolve(JSON.parse(line)) } catch { reject(new Error('Invalid Dimina runtime handshake')) }
        })
      })
      const base = new URL(hello.baseUrl)
      if (hello.protocol !== 1 || base.protocol !== 'http:' || base.hostname !== '127.0.0.1'
        || !base.pathname.endsWith('/sdk/control/') || !/^[a-f0-9]{48}$/.test(hello.token)) {
        throw new Error('Unsupported Dimina runtime handshake')
      }
      host.#base = base
      host.#token = hello.token
      lines.on('line', line => {
        try { host.#native(JSON.parse(line)) } catch { /* Ignore non-protocol output. */ }
      })
      child.once('exit', () => lines.close())
      return host
    } catch (error) {
      child.stdin.end()
      child.kill('SIGKILL')
      lines.close()
      child.stdout.resume()
      throw error
    }
  }

  #native(message) {
    if (message.type === 'native-cancel') {
      this.#calls.get(message.id)?.abort()
      this.#calls.delete(message.id)
      return
    }
    if (message.type !== 'native-call' || this.#stopped) return
    const controller = new AbortController()
    this.#calls.set(message.id, controller)
    const context = { appId: message.appId, windowId: message.windowId, signal: controller.signal }
    const respond = response => {
      if (!controller.signal.aborted && !this.#stopped) {
        let encoded = JSON.stringify({ type: 'native-result', id: message.id, ...response })
        if (Buffer.byteLength(encoded) > 1 << 20) encoded = JSON.stringify({ type: 'native-result', id: message.id, error: 'Native API result exceeds 1 MiB' })
        this.#process.stdin.write(encoded + '\n')
      }
    }
    Promise.resolve().then(() => {
      if (controller.signal.aborted || this.#stopped) return
      const handler = this.#apis.get(message.name)
      if (!handler) throw new Error('Native API handler is unavailable')
      return handler(message.params, context)
    }).then(value => {
      if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Native API must return a JSON object')
      respond({ value: value ?? {} })
    }).catch(error => {
      try { respond({ error: error?.message || String(error) }) } catch { /* The host may already be exiting. */ }
    }).finally(() => this.#calls.delete(message.id))
  }

  async registerApi(name, handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('Native API handler must be a function')
    const previous = this.#apis.get(name)
    this.#apis.set(name, handler)
    try { await this.#call('registerApi', { name, appIds: options.appIds, timeoutMs: options.timeoutMs }) }
    catch (error) {
      if (this.#apis.get(name) === handler) {
        if (previous) this.#apis.set(name, previous)
        else this.#apis.delete(name)
      }
      throw error
    }
  }

  async #call(method, payload, verb = 'POST') {
    if (this.#stopped || this.#disposal) throw new Error('Dimina runtime is stopped')
    return this.#request(method, payload, verb)
  }

  async #request(method, payload, verb = 'POST', signal = AbortSignal.timeout(100000)) {
    const response = await fetch(new URL(method, this.#base), {
      method: verb,
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: verb === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      signal,
    })
    let result
    try { result = await response.json() } catch { throw new Error(`Invalid runtime response (HTTP ${response.status})`) }
    if (!response.ok || result.error) throw new Error(result.error || `Runtime HTTP ${response.status}`)
    return result.value
  }

  async openApp(options) { return new DiminaWindow(this, await this.#call('open', options)) }
  focus(id) { return this.#call('focus', { id }) }
  closeApp(id) { return this.#call('close', { id }) }
  closeAll() { return this.#call('closeAll') }
  async windows() { return (await this.#call('windows', undefined, 'GET')).map(info => new DiminaWindow(this, info)) }
  importApp(path) { return this.#call('import', { path }) }

  dispose() {
    return this.#disposal ??= this.#disposeRuntime()
  }
  async #disposeRuntime() {
    if (this.#stopped) return
    try { await this.#request('closeAll', undefined, 'POST', AbortSignal.timeout(3000)) } finally {
      this.#stopped = true
      for (const controller of this.#calls.values()) controller.abort()
      this.#calls.clear()
      this.#process.stdin.end()
      const timer = setTimeout(() => this.#process.kill('SIGKILL'), 3000)
      try { await this.#exit } finally { clearTimeout(timer) }
    }
  }
  async [Symbol.asyncDispose]() { await this.dispose() }
}

