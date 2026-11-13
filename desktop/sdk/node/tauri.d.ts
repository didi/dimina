import type { OpenAppOptions, ImportedApp, DiminaWindow } from './types.js'
export * from './types.js'
/** One runtime is shared by the trusted frontend windows of a Tauri app. */
export declare class Dimina {
  private constructor()
  static start(): Promise<Dimina>
  openApp(options: OpenAppOptions): Promise<DiminaWindow>
  focus(id: string): Promise<void>
  closeApp(id: string): Promise<void>
  closeAll(): Promise<void>
  windows(): Promise<DiminaWindow[]>
  importApp(path: string): Promise<ImportedApp>
  dispose(): Promise<void>
}
