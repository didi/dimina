import { DMPBridgeCallback, DMPBridgeCallbackType, DMPTSUtil } from './DMPTSUtil';

import { DMPMap } from '../Utils/DMPMap';
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPApp } from '../DApp/DMPApp';
import { DMPModuleManager } from './DMPModuleManager';
import { DMPContainerBridgesModuleExt } from './DMPContainerBridgesModule+Ext';

export class DMPBridges {
  static callWebViewMethods(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, app: DMPApp): DMPMap | number | string | boolean | object {
    const callback: DMPBridgeCallback = (args: DMPMap, cbType: DMPBridgeCallbackType) => {
      if (params instanceof DMPMap) {
        let id = ''
        if (cbType == DMPBridgeCallbackType.Success) {
          if (!params.hasKey('success')) {
            return
          }
          id = params.get('success')
        } else if (cbType == DMPBridgeCallbackType.Fail) {
          if (!params.hasKey('fail')) {
            return
          }
          id = params.get('fail')
        } else if (cbType == DMPBridgeCallbackType.Complete) {
          if (!params.hasKey('complete')) {
            return
          }
          id = params.get('complete')
        }

        const msg: DMPMap = new DMPMap({
          type: 'triggerCallback',
          body: {
            id: id,
            args: {
              data: {
                success: cbType == DMPBridgeCallbackType.Success,
                data: args?.toObject() ?? new Object()
              }
            }
          }
        })

        DMPChannelProxyNext.ContainerToWebviewRender(msg, app, webViewId)
      }
    }

    // webview 部分的 bridge 暂时不接入 bridge
    const result = DMPBridges.invokeContainerMethodInfo(methodName, webViewId, params, callback, app.appModuleManager);
    return result;
  }

  static callMethodsNext(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, appIndex: number,
    moduleManager: DMPModuleManager): number | string | boolean | object {
    const callback: DMPBridgeCallback = (args: DMPMap, cbType: DMPBridgeCallbackType) => {
      if (params instanceof DMPMap) {
        let id = ''
        if (cbType == DMPBridgeCallbackType.Success) {
          if (!params.hasKey('success')) {
            return
          }
          id = params.get('success')
        } else if (cbType == DMPBridgeCallbackType.Fail) {
          if (!params.hasKey('fail')) {
            return
          }
          id = params.get('fail')
        } else if (cbType == DMPBridgeCallbackType.Complete) {
          if (!params.hasKey('complete')) {
            return
          }
          id = params.get('complete')
        }

        const msg: DMPMap = new DMPMap({
          type: 'triggerCallback',
          body: {
            id: id,
            args: args?.toObject() ?? new Object()
          }
        })
        DMPChannelProxyNext.ContainerToService(msg, appIndex)
      }
    }
    const result = DMPBridges.invokeContainerMethodInfo(methodName, webViewId, params, callback, moduleManager)
    return result;
  }

  /*
  * moduleName：module名
  * methodName：方法名
  * params： 传递的参数，可以为null，null表示不传递参数
  * unfold：是否将参数展开调用,默认false  传参方式 true: ...params false: params
  * callback：回调，默认最后一个参数
  * */
  private static invokeContainerMethodInfo(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, callback: DMPBridgeCallback,
    moduleManager: DMPModuleManager): number | string | boolean | object {
    let moduleName = 'DMPContainerBridgesModule';
    let invokeParams = params;
    if (params instanceof DMPMap && params.get('module')) {
      moduleName = params.get('module') as string
      if (moduleName === 'DMServiceBridgeModule' || moduleName === 'DMWebViewBridgeModule') {
        moduleName = 'DMPContainerBridgesModule';
      }
      invokeParams = DMPMap.createFromObject(params.get('data'))
    }

    // extBridge：params 中含 module 且该模块在 extModules 中注册
    // 直接委托给 DMPContainerBridgesModuleExt.handleExtBridge
    if (params instanceof DMPMap && params.get('module')) {
      const extMod = moduleManager.getExtBridgeModule();
      if (extMod && extMod.hasModule(moduleName)) {
        DMPLogger.d(Tags.BRIDGE, `extBridge: moduleName=${moduleName} event=${methodName}`);
        extMod.handleExtBridge(methodName, invokeParams instanceof DMPMap ? invokeParams : new DMPMap(),
          callback, moduleName);
        return new Object();
      }
    }

    // extOnBridge / extOffBridge：methodName 形如 `${module}_${event}`
    // FE 侧 extOnBridge 不传 module，而是将 apiName 设为 `${module}_${event}`
    if (!(params instanceof DMPMap && params.get('module'))) {
      const extMod = moduleManager.getExtBridgeModule();
      if (extMod) {
        const parsed = DMPBridges.parseExtEventName(methodName, extMod);
        if (parsed) {
          const mod = parsed.mod;
          const evt = parsed.evt;
          const isOff = params instanceof DMPMap && !params.hasKey('success') && !params.hasKey('keep');
          if (isOff) {
            DMPLogger.d(Tags.BRIDGE, `extOffBridge: module=${mod} event=${evt}`);
            extMod.handleExtOffBridge(methodName);
          } else {
            DMPLogger.d(Tags.BRIDGE, `extOnBridge: module=${mod} event=${evt}`);
            extMod.handleExtOnBridge(methodName,
              params instanceof DMPMap ? params : new DMPMap(),
              callback, mod, evt);
          }
          return new Object();
        }
      }
    }

    DMPLogger.d(Tags.BRIDGE, `moduleName=${moduleName}   methodName=${methodName} `)
    let result: object = new Object();
    let obj = moduleManager?.getModuleObjectByMethodNameAndModuleName(methodName, moduleName)
    if (obj) {
      try {
        return DMPTSUtil.invokeNativeMethod(obj, methodName, invokeParams, webViewId, callback)
      } catch (err) {
        DMPLogger.e(Tags.BRIDGE, `Bridge invoke error  ${methodName}, ${moduleName}, ${err.toString()}`);
      }
    } else {
      DMPLogger.e(Tags.BRIDGE, `Bridge not implemented  ${methodName}, ${moduleName}`);
    }
    return result;
  }

  /**
   * 尝试将 `${module}_${event}` 格式的 apiName 解析为模块名与事件名。
   * 仅当模块名在 extModules 中注册时才返回解析结果，否则返回 null。
   */
  private static parseExtEventName(
    apiName: string,
    extMod: DMPContainerBridgesModuleExt
  ): DMPExtParsedEvent | null {
    const sep = apiName.indexOf('_');
    if (sep <= 0) {
      return null;
    }
    const mod = apiName.substring(0, sep);
    const evt = apiName.substring(sep + 1);
    if (!evt || !extMod.hasModule(mod)) {
      return null;
    }
    const result = new DMPExtParsedEvent();
    result.mod = mod;
    result.evt = evt;
    return result;
  }
}

/** parseExtEventName 解析结果，ArkTS 要求使用 class 而非对象字面量类型 */
class DMPExtParsedEvent {
  mod: string = '';
  evt: string = '';
}



