import { invoke } from '@tauri-apps/api/core'
import { DiminaWindow } from './window.js'
export { DiminaWindow } from './window.js'

/** Uses the runtime configured by the host's tauri-plugin-dimina instance. */
export class Dimina {
  #stopped = false

  static async start() {
    await invoke('plugin:dimina|start')
    return new Dimina()
  }
  #call(method, args) {
    if (this.#stopped) return Promise.reject(new Error('Dimina runtime is stopped'))
    return invoke(`plugin:dimina|${method}`, args)
  }
  async openApp(options) { return new DiminaWindow(this, await this.#call('open', { options })) }
  focus(id) { return this.#call('focus', { id }) }
  closeApp(id) { return this.#call('close', { id }) }
  closeAll() { return this.#call('close_all') }
  async windows() { return (await this.#call('windows')).map(info => new DiminaWindow(this, info)) }
  importApp(path) { return this.#call('import', { path }) }
  async dispose() {
    if (this.#stopped) return
    await this.#call('dispose')
    this.#stopped = true
  }
}
