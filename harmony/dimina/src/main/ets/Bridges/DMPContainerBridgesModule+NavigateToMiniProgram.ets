import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPMap } from '../Utils/DMPMap'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback } from './DMPTSUtil'

export class DMPContainerBridgesModuleNavigateToMiniProgram extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return [
      'navigateToMiniProgram',
      'navigateBackMiniProgram',
      'exitMiniProgram',
      'restartMiniProgram'
    ]
  }

  async navigateToMiniProgram(data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'navigateToMiniProgram'
    try {
      const shortLink = this.optionalString(data, 'shortLink', apiName)
      if (shortLink) {
        throw new Error(`${apiName}:fail shortLink is not supported`)
      }
      const noRelaunchIfPathUnchanged = data.getBoolean('noRelaunchIfPathUnchanged')
      if (noRelaunchIfPathUnchanged !== undefined && typeof noRelaunchIfPathUnchanged !== 'boolean') {
        throw new Error(`${apiName}:fail invalid noRelaunchIfPathUnchanged`)
      }
      if (noRelaunchIfPathUnchanged === true) {
        throw new Error(`${apiName}:fail noRelaunchIfPathUnchanged is not supported`)
      }
      const appId = this.requiredString(data, 'appId', apiName)
      const path = this.optionalString(data, 'path', apiName)
      const envVersion = this.optionalString(data, 'envVersion', apiName)
      if (envVersion && envVersion !== 'release') {
        throw new Error(`${apiName}:fail envVersion ${envVersion} is not bundled`)
      }
      const extraData = this.optionalObject(data, 'extraData', apiName)
      await DMPAppManager.sharedInstance().navigateToMiniProgram(this.app, appId, path, extraData)
      this.invokeSuccessCallback(callback, this.successResult(apiName), true)
    } catch (error) {
      this.invokeFailureCallback(callback, null, this.failureMessage(apiName, error as Error), true)
    }
  }

  async navigateBackMiniProgram(data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'navigateBackMiniProgram'
    let callbackSettled = false
    try {
      const extraData = this.optionalObject(data, 'extraData', apiName)
      await DMPAppManager.sharedInstance().navigateBackMiniProgram(this.app, extraData, async () => {
        this.invokeSuccessCallback(callback, this.successResult(apiName), true)
        callbackSettled = true
        await this.app.service.flush()
      })
    } catch (error) {
      if (!callbackSettled) {
        this.invokeFailureCallback(callback, null, this.failureMessage(apiName, error as Error), true)
      }
    }
  }

  async exitMiniProgram(_data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'exitMiniProgram'
    let callbackSettled = false
    try {
      await DMPAppManager.sharedInstance().exitMiniProgram(this.app, async () => {
        this.invokeSuccessCallback(callback, this.successResult(apiName), true)
        callbackSettled = true
        await this.app.service.flush()
      })
    } catch (error) {
      if (!callbackSettled) {
        this.invokeFailureCallback(callback, null, this.failureMessage(apiName, error as Error), true)
      }
    }
  }

  async restartMiniProgram(data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'restartMiniProgram'
    let callbackSettled = false
    try {
      const path = this.requiredString(data, 'path', apiName)
      await DMPAppManager.sharedInstance().restartMiniProgram(this.app, path, async () => {
        this.invokeSuccessCallback(callback, this.successResult(apiName), true)
        callbackSettled = true
        await this.app.service.flush()
      })
    } catch (error) {
      if (!callbackSettled) {
        this.invokeFailureCallback(callback, null, this.failureMessage(apiName, error as Error), true)
      }
    }
  }

  private requiredString(data: DMPMap, key: string, apiName: string): string {
    const value: string | undefined = data.getString(key)
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${apiName}:fail ${key} is required`)
    }
    return value
  }

  private optionalString(data: DMPMap, key: string, apiName: string): string | undefined {
    const value: string | undefined = data.getString(key)
    if (value === undefined || value === null || value === '') {
      return undefined
    }
    if (typeof value !== 'string') {
      throw new Error(`${apiName}:fail invalid ${key}`)
    }
    return value
  }

  private optionalObject(data: DMPMap, key: string, apiName: string): DMPMap {
    const value: object | undefined = data.getObject(key)
    if (value === undefined || value === null) {
      return new DMPMap()
    }
    if (value instanceof DMPMap) {
      return value
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${apiName}:fail invalid ${key}`)
    }
    return DMPMap.createFromObject(value as Object)
  }

  private successResult(apiName: string): DMPMap {
    return new DMPMap({ errMsg: `${apiName}:ok` })
  }

  private failureMessage(apiName: string, error: Error): string {
    const message = error?.message ?? error?.toString() ?? 'unknown error'
    return message.startsWith(`${apiName}:fail`) ? message : `${apiName}:fail ${message}`
  }
}
