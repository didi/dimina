import { DMPApp } from '../DApp/DMPApp';
import { DMPMap } from '../Utils/DMPMap';
import { AppData, WorkerAppData } from '../Service/DMPSendableObjects';

import { DMPBridgeCallback, DMPBridgeCallbackType, isMainThread } from './DMPTSUtil';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor';


export abstract class DMPContainerBridgesModule {
  app: DMPApp;
  appData: AppData;

  constructor(app: DMPApp);

  constructor(app: WorkerAppData);

  constructor(app: DMPApp | WorkerAppData) {
    if (isMainThread()) {
      this.app = app as DMPApp;
      this.appData = new AppData();
    } else {
      this.app = app as DMPApp;
      this.appData = JSON.parse(JSON.stringify(app))
    }
  }

  invokeSuccessCallback(callback: DMPBridgeCallback, param: DMPMap | undefined | null,
    completeCarriesResult: boolean = true) {
    DMPLogger.d('invokeSuccessCallback', param?.toStr() ?? '')
    if (callback) {
      callback(param ? param : new DMPMap(), DMPBridgeCallbackType.Success)
    }
    this.invokeCompleteCallback(callback, completeCarriesResult ? param : null)
  }

  invokeFailureCallback(callback: DMPBridgeCallback, param: DMPMap | undefined | null, errMsg: string,
    completeCarriesResult: boolean = true) {
    DMPLogger.d('invokeFailureCallback', param?.toStr() ?? '', errMsg)
    if (callback) {
      param = param || new DMPMap();
      param.set('data', {
        'errMsg': errMsg ?? 'failure'
      })
      // JS fail 回调读取的是顶层 res.errMsg（与 invokeSuccessCallback 的顶层放置一致）——
      // 上面的 data.errMsg 嵌套从未被任何 JS 调用方解包过，导致 fail 回调实际收不到
      // errMsg。仅在调用方尚未预置顶层 errMsg 时才补上（部分 API 会自带更完整的
      // "xxx:fail ..." 消息），与 iOS DMPContainerApi.invokeCallback 的同名修复保持一致。
      if (!param.hasKey('errMsg')) {
        param.set('errMsg', errMsg ?? 'failure')
      }
      callback(param, DMPBridgeCallbackType.Fail)
    }
    this.invokeCompleteCallback(callback, completeCarriesResult ? param : null)
  }

  abstract getExportMethods(): Array<string>;

  protected currentAppId(): string {
    return this.appData.appId || this.app?.appConfig?.appId || 'default';
  }

  protected localPathFromVPath(path: string): string {
    const canvasTempRoot = DMPFileUrlConvertor.canvasTempRoot(this.currentAppId());
    return DMPFileUrlConvertor.localPathFromVPath(path, canvasTempRoot);
  }

  private invokeCompleteCallback(callback: DMPBridgeCallback, param: DMPMap | undefined | null) {
    DMPLogger.d('invokeCompleteCallback', param?.toStr() ?? '')
    if (callback) {
      callback(param ? param : new DMPMap(), DMPBridgeCallbackType.Complete)
    }
  }
}



