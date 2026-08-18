import { DMPMap } from '../Utils/DMPMap'

/**
 * A logical mini-program presentation frame. Native page ownership continues to
 * live in DMPPageRecord; this stack must never infer a NavPathStack pop count.
 */
export class DMPMiniProgramPresentationFrame {
  appIndex: number
  appId: string
  openerAppIndex?: number

  constructor(appIndex: number, appId: string, openerAppIndex?: number) {
    this.appIndex = appIndex
    this.appId = appId
    this.openerAppIndex = openerAppIndex
  }
}

/**
 * Pure state holder used by DMPAppManager. Keeping it independent of DMPApp
 * makes the opener/top invariants unit-testable without creating ArkUI Workers.
 */
export class DMPMiniProgramPresentationStack {
  private frames: DMPMiniProgramPresentationFrame[] = []

  size(): number {
    return this.frames.length
  }

  top(): DMPMiniProgramPresentationFrame | undefined {
    return this.frames[this.frames.length - 1]
  }

  /** Register the first host-opened mini program, or validate the current top. */
  ensureRoot(appIndex: number, appId: string): boolean {
    if (this.frames.length === 0) {
      this.frames.push(new DMPMiniProgramPresentationFrame(appIndex, appId))
      return true
    }
    return this.top()?.appIndex === appIndex
  }

  push(callerAppIndex: number, targetAppIndex: number, targetAppId: string): boolean {
    if (this.top()?.appIndex !== callerAppIndex) {
      return false
    }
    if (this.frames.some((frame: DMPMiniProgramPresentationFrame): boolean => frame.appId === targetAppId)) {
      return false
    }
    this.frames.push(new DMPMiniProgramPresentationFrame(targetAppIndex, targetAppId, callerAppIndex))
    return true
  }

  openerAppIndex(currentAppIndex: number): number | undefined {
    const current = this.top()
    if (current?.appIndex !== currentAppIndex) {
      return undefined
    }
    return current.openerAppIndex
  }

  pop(currentAppIndex: number): DMPMiniProgramPresentationFrame | undefined {
    if (this.top()?.appIndex !== currentAppIndex) {
      return undefined
    }
    return this.frames.pop()
  }

  removeApp(appIndex: number): void {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      if (this.frames[index].appIndex === appIndex) {
        this.frames.splice(index, 1)
        return
      }
    }
  }
}

export class DMPMiniProgramPath {
  pagePath: string
  query: DMPMap

  constructor(pagePath: string, query: DMPMap) {
    this.pagePath = pagePath
    this.query = query
  }
}

/** Parser for the `path?query` contract shared by the four navigation APIs. */
export class DMPMiniProgramPathParser {
  static parse(rawPath: string): DMPMiniProgramPath {
    const questionMark = rawPath.indexOf('?')
    const pathEnd = questionMark >= 0 ? questionMark : rawPath.length
    const pagePath = rawPath.slice(0, pathEnd).replace(/^\/+/, '')
    const query = new DMPMap()
    const queryString = questionMark >= 0 ? rawPath.slice(questionMark + 1) : ''

    if (queryString.length > 0) {
      queryString.split('&').forEach((item: string) => {
        if (item.length === 0) {
          return
        }
        const equals = item.indexOf('=')
        const rawKey = equals >= 0 ? item.slice(0, equals) : item
        const rawValue = equals >= 0 ? item.slice(equals + 1) : ''
        if (rawKey.length > 0) {
          query.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue))
        }
      })
    }

    return new DMPMiniProgramPath(pagePath, query)
  }
}
