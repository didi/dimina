import { DMPMap } from '../Utils/DMPMap';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil';
import { DMPExtCallback, DMPExtModuleHandler } from './DMPExtModuleHandler';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPApp } from '../DApp/DMPApp';

/** extBridge 一次性调用的回调实现 */
class ExtBridgeCallback extends DMPExtCallback {
  private event: string;
  private nativeCallback: DMPBridgeCallback;

  constructor(event: string, nativeCallback: DMPBridgeCallback) {
    super();
    this.event = event;
    this.nativeCallback = nativeCallback;
  }

  onSuccess(result: DMPMap): void {
    result.set('errMsg', `${this.event}:ok`);
    this.nativeCallback(result, DMPBridgeCallbackType.Success);
    this.nativeCallback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }

  onFail(error: DMPMap): void {
    if (!error.hasKey('errMsg')) {
      error.set('errMsg', `${this.event}:fail`);
    }
    this.nativeCallback(error, DMPBridgeCallbackType.Fail);
    this.nativeCallback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }
}

/** extOnBridge 持续订阅的回调实现（不触发 complete） */
class ExtOnBridgeCallback extends DMPExtCallback {
  private realEvent: string;
  private nativeCallback: DMPBridgeCallback;

  constructor(realEvent: string, nativeCallback: DMPBridgeCallback) {
    super();
    this.realEvent = realEvent;
    this.nativeCallback = nativeCallback;
  }

  onSuccess(result: DMPMap): void {
    result.set('errMsg', `${this.realEvent}:ok`);
    this.nativeCallback(result, DMPBridgeCallbackType.Success);
  }

  onFail(error: DMPMap): void {
    if (!error.hasKey('errMsg')) {
      error.set('errMsg', `${this.realEvent}:fail`);
    }
    this.nativeCallback(error, DMPBridgeCallbackType.Fail);
  }
}

/**
 * 处理 service 侧 extBridge / extOnBridge / extOffBridge 调用。
 *
 * extBridge 调用链：
 *   extBridge({ event, module, data, success, fail, complete })
 *   → invokeAPI(name=event, params={ module, data, ... })
 *   → DMPBridges 检测到 params.module 且模块已注册 → handleExtBridge
 *
 * extOnBridge 调用链：
 *   extOnBridge({ module, event, callBack })
 *   → invokeAPI(name=`${module}_${event}`, params={ evtId, keep, success })
 *   → DMPBridges 解析前缀 → handleExtOnBridge
 *
 * extOffBridge 调用链：
 *   extOffBridge({ module, event })
 *   → invokeAPI(name=`${module}_${event}`, params={})
 *   → DMPBridges 解析前缀 → handleExtOffBridge
 */
export class DMPContainerBridgesModuleExt extends DMPContainerBridgesModule {
  private extModules: Map<string, DMPExtModuleHandler>;

  /** key = `${module}_${event}`，value = 宿主返回的取消函数 */
  private subscriptions: Map<string, () => void> = new Map();

  constructor(app: DMPApp, extModules: Map<string, DMPExtModuleHandler>) {
    super(app);
    this.extModules = extModules;
  }

  getExportMethods(): string[] {
    // extBridge 不注册固定方法名，由 DMPBridges 动态路由
    return [];
  }

  /** 判断模块是否已注册 */
  hasModule(moduleName: string): boolean {
    return this.extModules.has(moduleName);
  }

  /**
   * 处理 extBridge 一次性调用。
   *
   * @param event      service 侧传入的 event 值（如 "getUserInfo"）
   * @param data       extBridge 的 data 字段
   * @param callback   框架组装的回调分发函数
   * @param moduleName 宿主模块名
   */
  handleExtBridge(event: string, data: DMPMap, callback: DMPBridgeCallback, moduleName: string) {
    const handler = this.extModules.get(moduleName);
    if (!handler) {
      DMPLogger.e(Tags.BRIDGE, `extBridge:fail module "${moduleName}" not registered`);
      const errMap = new DMPMap();
      errMap.set('errMsg', `extBridge:fail module "${moduleName}" not registered`);
      callback(errMap, DMPBridgeCallbackType.Fail);
      callback(new DMPMap(), DMPBridgeCallbackType.Complete);
      return;
    }

    const extCallback = new ExtBridgeCallback(event, callback);

    try {
      handler(event, data, extCallback);
    } catch (err) {
      DMPLogger.e(Tags.BRIDGE, `extBridge:fail ${err}`);
      const errMap = new DMPMap();
      errMap.set('errMsg', `${event}:fail ${err}`);
      callback(errMap, DMPBridgeCallbackType.Fail);
      callback(new DMPMap(), DMPBridgeCallbackType.Complete);
    }
  }

  /**
   * 处理 extOnBridge 持续订阅。
   *
   * @param subKey     `${module}_${event}` 格式的订阅 key
   * @param data       params（含 evtId、keep 等）
   * @param callback   框架回调（每次事件推送均触发 success）
   * @param moduleName 宿主模块名
   * @param realEvent  真实事件名
   */
  handleExtOnBridge(
    subKey: string,
    data: DMPMap,
    callback: DMPBridgeCallback,
    moduleName: string,
    realEvent: string,
  ) {
    const handler = this.extModules.get(moduleName);
    if (!handler) {
      DMPLogger.e(Tags.BRIDGE, `extOnBridge:fail module "${moduleName}" not registered`);
      const errMap = new DMPMap();
      errMap.set('errMsg', `extOnBridge:fail module "${moduleName}" not registered`);
      callback(errMap, DMPBridgeCallbackType.Fail);
      callback(new DMPMap(), DMPBridgeCallbackType.Complete);
      return;
    }

    // 若已有旧订阅，先取消（对齐文档"重复订阅同一事件，先取消旧订阅"语义）
    this.cancelSubscription(subKey);

    const extCallback = new ExtOnBridgeCallback(realEvent, callback);

    try {
      const cancelFn = handler(realEvent, data, extCallback);
      if (cancelFn) {
        this.subscriptions.set(subKey, cancelFn);
      }
    } catch (err) {
      DMPLogger.e(Tags.BRIDGE, `extOnBridge:fail ${err}`);
      const errMap = new DMPMap();
      errMap.set('errMsg', `${realEvent}:fail ${err}`);
      callback(errMap, DMPBridgeCallbackType.Fail);
    }
  }

  /**
   * 处理 extOffBridge 取消订阅。
   *
   * @param subKey  `${module}_${event}` 格式的订阅 key
   */
  handleExtOffBridge(subKey: string) {
    this.cancelSubscription(subKey);
  }

  /** 取消并移除指定 key 的订阅 */
  cancelSubscription(subKey: string) {
    const cancel = this.subscriptions.get(subKey);
    if (cancel) {
      try {
        cancel();
      } catch (err) {
        DMPLogger.e(Tags.BRIDGE, `extOffBridge cancel error: ${err}`);
      }
      this.subscriptions.delete(subKey);
    }
  }

  /** 销毁时取消全部订阅，防止泄漏 */
  cancelAllSubscriptions() {
    this.subscriptions.forEach((cancel, key) => {
      try {
        cancel();
      } catch (err) {
        DMPLogger.e(Tags.BRIDGE, `cancelAllSubscriptions error key=${key}: ${err}`);
      }
    });
    this.subscriptions.clear();
  }
}
