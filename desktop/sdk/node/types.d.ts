export interface OpenAppOptions { appId: string; path?: string; name?: string }
export interface ImportedApp { appId: string; name: string; path: string; imported: boolean }
export interface NativeApiOptions { appIds?: string[]; timeoutMs?: number }
export interface NativeApiContext { appId: string; windowId: string; signal: AbortSignal }
export type NativeApiHandler = (params: Record<string, unknown>, context: NativeApiContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
export declare class DiminaWindow {
  private constructor()
  readonly id: string
  readonly appId: string
  readonly name: string
  readonly ready: boolean
  focus(): Promise<void>
  close(): Promise<void>
}
