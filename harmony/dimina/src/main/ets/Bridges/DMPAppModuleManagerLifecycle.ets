import { DMPExtModuleHandler } from './DMPExtModuleHandler'

/** Minimal runtime contract needed to rebuild app-scoped native bridge modules. */
export interface DMPDisposableAppModuleManager {
  registerExtModule(moduleName: string, handler: DMPExtModuleHandler): void
  dispose(): void
}

export type DMPAppModuleManagerFactory = () => DMPDisposableAppModuleManager

/**
 * Owns the disposable bridge-module generation for one DMPApp.
 *
 * Host extension handlers outlive a JS runtime restart, while the module manager and all of its
 * native listeners do not. Rebuilding therefore creates a new manager and replays only the host
 * registrations into it.
 */
export class DMPAppModuleManagerLifecycle {
  private currentManager: DMPDisposableAppModuleManager
  private readonly factory: DMPAppModuleManagerFactory
  private readonly extModules: Map<string, DMPExtModuleHandler> = new Map()
  private currentManagerDisposed: boolean = false

  constructor(initialManager: DMPDisposableAppModuleManager, factory: DMPAppModuleManagerFactory) {
    this.currentManager = initialManager
    this.factory = factory
  }

  get manager(): DMPDisposableAppModuleManager {
    return this.currentManager
  }

  registerExtModule(moduleName: string, handler: DMPExtModuleHandler): void {
    this.extModules.set(moduleName, handler)
    if (!this.currentManagerDisposed) {
      this.currentManager.registerExtModule(moduleName, handler)
    }
  }

  disposeCurrent(): void {
    if (this.currentManagerDisposed) {
      return
    }
    this.currentManagerDisposed = true
    this.currentManager.dispose()
  }

  rebuild(): DMPDisposableAppModuleManager {
    this.disposeCurrent()
    const nextManager = this.factory()
    this.extModules.forEach((handler: DMPExtModuleHandler, moduleName: string): void => {
      nextManager.registerExtModule(moduleName, handler)
    })
    this.currentManager = nextManager
    this.currentManagerDisposed = false
    return nextManager
  }
}
