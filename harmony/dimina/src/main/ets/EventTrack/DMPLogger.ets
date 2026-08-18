import { systemDateTime } from '@kit.BasicServicesKit';
import { DMPContextUtils } from '../Utils/DMPContextUtils';

export class DMPLogger {
  static commonTag = "[dimina]"
  static isOpenDebugLog = true

  private static canLog(): boolean {
    return DMPLogger.isOpenDebugLog && DMPContextUtils.debugMode
  }

  static w(tag: string = '', ...args: string[]) {
    if (!DMPLogger.canLog()) return
    console.warn(`${tag}`, ...args)
  }

  static i(tag: string = '', ...args: string[]) {
    if (!DMPLogger.canLog()) return
    console.info(`${tag}`, ...args)
  }

  static d(tag: string = '', ...args: string[]) {
    if (!DMPLogger.canLog()) return
    console.debug(`${tag}[${systemDateTime.getTime()}]`, ...args)
  }

  static e(tag: string = '', ...args: string[]) {
    if (!DMPLogger.canLog()) return
    console.error(`${tag}`, ...args)
  }
}
