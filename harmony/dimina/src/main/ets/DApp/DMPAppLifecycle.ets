import window from '@ohos.window';
import { DMPAppManager } from './DMPAppManager';

import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPMap } from '../Utils/DMPMap';
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
      const msg: DMPMap = new DMPMap({
        type: 'appShow',
        body: {
          bridgeId: app.currentWebViewId
        }
      })
      DMPChannelProxyNext.ContainerToService(msg, app.appIndex)
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
      const msg: DMPMap = new DMPMap({
        type: 'appHide',
        body: {
          bridgeId: app.currentWebViewId
        }
      })
      DMPChannelProxyNext.ContainerToService(msg, app.appIndex)
    }
  }


  static onWindowStageEvent(stageEventType: window.WindowStageEventType) {
    switch (stageEventType) {
      case window.WindowStageEventType.SHOWN: // 切到前台
        DMPWebSocketManager.sharedInstance().setAllBackgrounded(false)
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
        DMPAppLifecycle.onHide()
        DMPLogger.i(Tags.APP_LIFECYCLE, 'windowStage background.');
        break;
      default:
        break;
    }
  }
}
