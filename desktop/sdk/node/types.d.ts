export interface OpenAppOptions { appId: string; path?: string; name?: string }
export interface ImportedApp { appId: string; name: string; path: string; imported: boolean }
export declare class DiminaWindow {
  private constructor()
  readonly id: string
  readonly appId: string
  readonly name: string
  readonly ready: boolean
  focus(): Promise<void>
  close(): Promise<void>
}
