import { DMPMap } from '../Utils/DMPMap';
import { process } from '@kit.ArkTS'

const LOW_PRIORITY = '__low'
const HIGH_PRIORITY = '__high'

export class DMPTSUtil {
  static invokeNativeMethod(obj: any, methodName: string, params: DMPMap | number | string | boolean | object,
    webViewId: number, callback: DMPBridgeCallback): DMPMap | number | string | boolean | object {
    let result: DMPMap | number | string | boolean | object = new DMPMap();
    let originMethod = methodName
    if (methodName.includes(LOW_PRIORITY)) {
      originMethod = methodName.replace(LOW_PRIORITY, '')
    } else if (methodName.includes(HIGH_PRIORITY)) {
      originMethod = methodName.replace(HIGH_PRIORITY, '')
    }
    if (!params) {
      params = new Object();
    }
    if (originMethod.startsWith('FileSystemManager.') && obj.dispatchFileSystemManager) {
      result = obj.dispatchFileSystemManager.call(obj, originMethod, params, callback)
    } else if ((originMethod.startsWith('UDPSocket.') || originMethod.startsWith('TCPSocket.') ||
      originMethod.includes('LocalService')) && obj.dispatchLocalNetwork) {
      result = obj.dispatchLocalNetwork.call(obj, originMethod, params, callback)
    } else if (webViewId > 0) {
      result = obj[originMethod].call(obj, params, callback, webViewId)
    } else {
      result = obj[originMethod].call(obj, params, callback)
    }

    // 桥方法的返回值是 invoke 的同步结果，要跨 worker 边界序列化后再转成 QuickJS 值。
    // async 方法返回的 Promise 不可序列化，会让整次 invoke 抛出（service 侧读同步返回值即崩），而它们的结果本来就走 success/fail 回调，同步侧没有值可给。
    // 这里统一收敛成空结果，并给 rejection 兜一个日志出口，避免变成静默的 unhandled rejection。
    if (result instanceof Promise) {
      result.catch((err: Error) => {
        console.error(`[d-bridges] async bridge method rejected: ${originMethod} ${err}`)
      })
      return new Object()
    }

    return result
  }
}

export function isMainThread(): boolean {
  return process.pid == process.tid;
}


export enum DMPExportMethodPriority {
  Low,
  Default,
  High
}

export function DMPExportMethod(methodName: string, methodPriority = DMPExportMethodPriority.Default): string {
  if (methodPriority == DMPExportMethodPriority.Low) {
    return `${methodName}${LOW_PRIORITY}`
  } else if (methodPriority == DMPExportMethodPriority.High) {
    return `${methodName}${HIGH_PRIORITY}`
  } else {
    return methodName
  }
}


export enum DMPBridgeCallbackType {
  Success,
  Fail,
  Complete
}

// `callbackId` is reserved for persistent task events (progress, headers, etc.).
// One-shot success/fail/complete calls omit it and keep their existing routing.
export type DMPBridgeCallback = (args: DMPMap, cbType: DMPBridgeCallbackType,
  callbackId?: string) => void;
