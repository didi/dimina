import window from '@ohos.window';
import { DMPAppManager } from './DMPAppManager';

import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPScene } from './config/DMPLaunchConfig';
import { DMPWebSocketManager } from '../Bridges/Network/DMPWebSocketManager';

export class DMPAppLifecycle {
  constructor() {
  }

  /**
   * 小程序隐藏API - onAppRoute(eventListener) | 微信开放社区
   * https://developers.weixin.qq.com/community/develop/article/doc/00006c80998d182690edbb60c56413
   */
  static onAppRoute() {

  }

  // 框架接口 / 小程序 App / App
  // https://developers.weixin.qq.com/miniprogram/dev/reference/api/App.html#onHide
  static onShow() {
    DMPAppLifecycle.onAppShow()
  }

  // 基础 / 小程序 / 应用级事件 / wx.onAppShow
  // https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onAppShow.html
  static onAppShow() {
    const app = DMPAppManager.sharedInstance().getPresentedApp()
    if (app) {
      // Per 微信 App/Page 生命周期语义，App 从系统后台恢复前台时，当前显示页面也要收到
      // Page.onShow（不只是 App.onShow）——这与是否跨小程序导航无关，是任何前台恢复场景
      // 都成立的标准行为。notifyMiniProgramShow 早已实现"App+Page 双派发"（供跨小程序导航
      // 复用），这里借用它只是为了不重复实现同一套派发逻辑；顺带保留了 app 自身的
      // scene/path/query，不再像旧实现那样用裸 bridgeId body 覆盖 getEnterOptionsSync。
      const launchConfig = app.getLaunchConfig()
      app.notifyMiniProgramShow(launchConfig?.scene ?? DMPScene.fromMainEntry, launchConfig?.referrerInfo)
    }
  }

  // 框架接口 / 小程序 App / App
  // https://developers.weixin.qq.com/miniprogram/dev/reference/api/App.html#onHide
  static onHide() {
    DMPAppLifecycle.onAppHide()
  }

  // 基础 / 小程序 / 应用级事件 / wx.onAppHide
  // https://developers.weixin.qq.com/miniprogram/dev/api/base/app/app-event/wx.onAppHide.html
  static onAppHide() {
    const app = DMPAppManager.sharedInstance().getPresentedApp()
    if (app) {
      app.notifyMiniProgramHide()
    }
  }


  static onWindowStageEvent(stageEventType: window.WindowStageEventType) {
    switch (stageEventType) {
      case window.WindowStageEventType.SHOWN: // 切到前台
        DMPWebSocketManager.sharedInstance().setAllBackgrounded(false)
        // 宿主可见性要在派发之前更新：跨小程序恢复 opener 会读它决定是派发还是暂存。
        DMPAppManager.sharedInstance().setHostVisible(true)
        DMPAppLifecycle.onShow()
        DMPLogger.i(Tags.APP_LIFECYCLE, 'windowStage foreground.');
        break;
      case window.WindowStageEventType.ACTIVE: // 获焦状态
        DMPLogger.i(Tags.APP_LIFECYCLE, 'windowStage active.');
        break;
      case window.WindowStageEventType.INACTIVE: // 失焦状态
        DMPLogger.i(Tags.APP_LIFECYCLE, 'windowStage inactive.');
        break;
      case window.WindowStageEventType.HIDDEN: // 切到后台
        DMPWebSocketManager.sharedInstance().setAllBackgrounded(true)
        DMPAppManager.sharedInstance().setHostVisible(false)
        DMPAppLifecycle.onHide()
        DMPLogger.i(Tags.APP_LIFECYCLE, 'windowStage background.');
        break;
      default:
        break;
    }
  }
}
