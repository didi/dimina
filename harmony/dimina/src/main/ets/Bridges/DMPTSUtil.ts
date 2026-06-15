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
    } else if (webViewId > 0) {
      result = obj[originMethod].call(obj, params, callback, webViewId)
    } else {
      result = obj[originMethod].call(obj, params, callback)
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

export type DMPBridgeCallback = (args: DMPMap, cbType: DMPBridgeCallbackType) => void;
