/**
 * wx.connectSocket / SocketTask 鸿蒙桥接壳。
 *
 * 只做三件事：登记/刷新该 owner 的 appId→appIndex 映射（供 Manager 推送
 * triggerCallback 用）、按 params 是否含 socketId 分支任务态/全局遗留态（分支本身
 * 下沉到 Manager 内部)、把调用委托给 DMPWebSocketManager。全部一次性回调
 * （success/fail/complete）均由 Manager 直接驱动 callback 触发，本类不重复调用
 * invokeSuccessCallback/invokeFailureCallback。
 */
import { DMPContainerBridgesModule } from '../DMPContainerBridgesModule';
import { DMPBridgeCallback } from '../DMPTSUtil';
import { DMPMap } from '../../Utils/DMPMap';
import { DMPApp } from '../../DApp/DMPApp';
import { DMPWebSocketManager } from './DMPWebSocketManager';
import { DMPChannelProxyNext } from '../../Service/DMPChannelProxyNext';
import { DMPLogger } from '../../EventTrack/DMPLogger';
import { Tags } from '../../EventTrack/Tags';

export class DMPContainerBridgesModuleWebSocket extends DMPContainerBridgesModule {
  constructor(app: DMPApp) {
    super(app);
    const manager = DMPWebSocketManager.sharedInstance();
    // 注意：这里不能立刻调用 manager.attachOwner(app.appConfig.appId, app.appIndex) ——
    // 本构造函数是在 DMPApp 的字段初始化阶段（DMPApp.ets 的
    // `_appModuleManager: DMPAppModuleManager = new DMPAppModuleManager(this)`）被调用的，
    // 此时 DMPApp 构造函数体尚未执行（`this.appConfig = appConfig` 在字段初始化之后才赋值），
    // app.appConfig 仍是 undefined，读取 app.appConfig.appId 会直接 TypeError 崩溃。
    // owner 的 appId→appIndex 绑定改为惰性：connectSocket 内部已经会自愈调用一次
    // attachOwner（见 DMPWebSocketManager.ts 的自愈注释），其余方法均通过
    // getOrCreateOwner(appId) 按需创建 owner，不依赖此处提前调用。
    // Manager 本体是 .ts（避免 ArkTS 静态检查限制，见 DMPWebSocketManager.ts 顶部注释），
    // 不能直接 import .ets 文件；事件推送与日志改为在此（.ets）侧注入实现。
    manager.setProductionEmitter((appIndex: number, callbackId: string, payload: object) => {
      const msg = new DMPMap({
        type: 'triggerCallback',
        body: { id: callbackId, args: payload },
      });
      DMPChannelProxyNext.ContainerToService(msg, appIndex);
    });
    manager.setProductionLogger({
      d: (tag: string, msg: string) => DMPLogger.d(Tags.BRIDGE, msg),
      e: (tag: string, msg: string) => DMPLogger.e(Tags.BRIDGE, msg),
    });
  }

  getExportMethods(): string[] {
    return [
      'connectSocket',
      'sendSocketMessage',
      'closeSocket',
      'onSocketOpen',
      'onSocketMessage',
      'onSocketError',
      'onSocketClose',
      'offSocketOpen',
      'offSocketMessage',
      'offSocketError',
      'offSocketClose',
    ];
  }

  connectSocket(params: DMPMap, callback: DMPBridgeCallback): void {
    // 版本号直接问 bundleLoader 要，不走 this.appData.jsAppVersion：主线程上的
    // appData 是空壳（见 DMPContainerBridgesModule 构造函数），只有 worker 那份才有值。
    const appVersion = this.app.bundleManager.bundleLoader.getJsAppVersion() ?? '';
    const manager = DMPWebSocketManager.sharedInstance();
    // app.json 的 networkTimeout.connectSocket 是这个小程序的连接超时默认值，夹在调用方
    // 传的 timeout 与容器兜底值之间。配置跟小程序包一起解析（bundleAppConfigNext），
    // 这里每次调用都同步一次，不依赖某个一次性的启动时机；包还没解析完时按「没配」登记。
    manager.updateNetworkTimeout(this.app.appConfig.appId,
      this.app.bundleManager.bundleAppConfigNext?.networkTimeoutConnectSocketMs ?? null);
    manager.connectSocket(this.app.appConfig.appId, this.app.appIndex, appVersion, params, callback);
  }

  sendSocketMessage(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().sendSocketMessage(this.app.appConfig.appId, params, callback);
  }

  closeSocket(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().closeSocket(this.app.appConfig.appId, params, callback);
  }

  onSocketOpen(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().onSocketEvent('open', this.app.appConfig.appId, params, callback);
  }

  onSocketMessage(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().onSocketEvent('message', this.app.appConfig.appId, params, callback);
  }

  onSocketError(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().onSocketEvent('error', this.app.appConfig.appId, params, callback);
  }

  onSocketClose(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().onSocketEvent('close', this.app.appConfig.appId, params, callback);
  }

  offSocketOpen(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().offSocketEvent('open', this.app.appConfig.appId, params, callback);
  }

  offSocketMessage(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().offSocketEvent('message', this.app.appConfig.appId, params, callback);
  }

  offSocketError(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().offSocketEvent('error', this.app.appConfig.appId, params, callback);
  }

  offSocketClose(params: DMPMap, callback: DMPBridgeCallback): void {
    DMPWebSocketManager.sharedInstance().offSocketEvent('close', this.app.appConfig.appId, params, callback);
  }
}
