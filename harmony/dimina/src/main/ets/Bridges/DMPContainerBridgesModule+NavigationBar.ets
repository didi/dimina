import { DMPPageStyle } from '../DPages/DMPPageStyle';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPMap } from '../Utils/DMPMap';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';

import { DMPBridgeCallback } from './DMPTSUtil';

const VALID_FRONT_COLORS: string[] = ['#ffffff', '#000000']

export class DMPContainerBridgesModuleNavigationBar extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['setNavigationBarTitle', 'setNavigationBarColor', 'setNavigationTitleColor', 'showNavigationBar',
      'hideNavigationBar', 'hideHomeButton', 'showNavigationBarLoading', 'hideNavigationBarLoading'];
  }

  setNavigationBarTitle(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const title: string = data.get('title');
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)?.pageStyle?.navStyle)
    navStyle.set('navigationBarTitleText', title)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  setNavigationBarColor(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const frontColor: string = data.get("frontColor")
    const backgroundColor: string = data.get('backgroundColor');

    // frontColor 校验：只接受 #ffffff 和 #000000
    if (frontColor && !VALID_FRONT_COLORS.includes(frontColor.toLowerCase())) {
      this.invokeFailureCallback(callback, null,
        'invalid frontColor, only #ffffff and #000000 are accepted')
      return
    }

    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    if (frontColor) {
      navStyle.set("navigationBarTextStyle",
        frontColor.toLowerCase() === "#ffffff" ? "white" : "black")
    }
    if (backgroundColor) {
      navStyle.set('navigationBarBackgroundColor', backgroundColor)
    }

    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)

    DMPLogger.d(Tags.BRIDGE, 'navStyle=' + navStyle.toStr())
    this.invokeSuccessCallback(callback, null)
  }

  setNavigationTitleColor(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    let titleColor: string = data.get('titleColor');
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    navStyle.set('navigationBarTextColor', titleColor)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  showNavigationBar(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    navStyle.set('isHide', false)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  hideNavigationBar(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    navStyle.set('isHide', true)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  // 微信语义：仅支持隐藏，无对应的显示 API；隐藏后该页面实例生命周期内不再恢复
  hideHomeButton(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    // 页面销毁 / reLaunch 清栈后的迟到调用按 fail 返回，不崩容器
    const record = this.app.navigatorManager.getPageRecordById(webViewId)
    if (!record) {
      this.invokeFailureCallback(callback, null, 'hideHomeButton:fail page not found')
      return
    }
    const navStyle = DMPMap.createFromDMPMap(record.pageStyle?.navStyle)
    navStyle.set('hideHomeButton', true)
    record.pageStyle = new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  showNavigationBarLoading(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    navStyle.set('navigationBarLoading', true)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }

  hideNavigationBarLoading(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const navStyle =
      DMPMap.createFromDMPMap(this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle?.navStyle)
    navStyle.set('navigationBarLoading', false)
    this.app.navigatorManager.getPageRecordById(webViewId)!.pageStyle =
      new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.invokeSuccessCallback(callback, null)
  }
}
