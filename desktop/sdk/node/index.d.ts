export interface DesktopOptions {
  runtimePath: string
  packagesDir: string
  dataDir: string
  startupTimeoutMs?: number
  onLog?: (message: string) => void
}
import type { OpenAppOptions, ImportedApp, DiminaWindow, NativeApiHandler, NativeApiOptions } from './types.js'
export * from './types.js'
export declare class Dimina {
  private constructor()
  static start(options: DesktopOptions): Promise<Dimina>
  registerApi(name: string, handler: NativeApiHandler, options?: NativeApiOptions): Promise<void>
  openApp(options: OpenAppOptions): Promise<DiminaWindow>
  focus(id: string): Promise<void>
  closeApp(id: string): Promise<void>
  closeAll(): Promise<void>
  windows(): Promise<DiminaWindow[]>
  importApp(path: string): Promise<ImportedApp>
  dispose(): Promise<void>
}
