import { DMPApp } from '../DApp/DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPMap } from '../Utils/DMPMap'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback } from './DMPTSUtil'

export class DMPContainerBridgesModuleTabBar extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return [
      'setTabBarStyle',
      'setTabBarItem',
      'showTabBar',
      'hideTabBar',
      'setTabBarBadge',
      'removeTabBarBadge',
      'showTabBarRedDot',
      'hideTabBarRedDot'
    ]
  }

  private emitTabBarEvent(data: DMPMap) {
    try {
      DMPApp.context.eventHub.emit('tabbar_api', data)
    } catch (err) {
      DMPLogger.e(Tags.TABBAR, `Failed to emit tabbar_api event: ${err}`)
    }
  }

  private getTabBarListLength(): number {
    return this.app.bundleManager.getJsAppModuleConfig()?.tabBar?.list?.length ?? 0
  }

  private hasTabBar(): boolean {
    return this.getTabBarListLength() > 0
  }

  setTabBarStyle(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    if (!this.hasTabBar()) {
      this.invokeFailureCallback(callback, null, 'setTabBarStyle:fail tabBar not configured')
      return
    }
    DMPLogger.d(Tags.TABBAR, `setTabBarStyle: ${data.toStr()}`)
    const evt = new DMPMap()
    evt.set('type', 'setTabBarStyle')
    evt.set('color', data.get('color'))
    evt.set('selectedColor', data.get('selectedColor'))
    evt.set('backgroundColor', data.get('backgroundColor'))
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  setTabBarItem(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const listLength = this.getTabBarListLength()
    if (listLength === 0) {
      this.invokeFailureCallback(callback, null, 'setTabBarItem:fail tabBar not configured')
      return
    }
    const index: number = data.getNumber('index') ?? -1
    if (index < 0 || index >= listLength) {
      this.invokeFailureCallback(callback, null, `setTabBarItem:fail invalid index ${index}`)
      return
    }
    DMPLogger.d(Tags.TABBAR, `setTabBarItem: index=${index}, ${data.toStr()}`)
    const evt = new DMPMap()
    evt.set('type', 'setTabBarItem')
    evt.set('index', index)
    evt.set('text', data.get('text'))
    evt.set('iconPath', data.get('iconPath'))
    evt.set('selectedIconPath', data.get('selectedIconPath'))
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  showTabBar(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    DMPLogger.d(Tags.TABBAR, 'showTabBar')
    const evt = new DMPMap()
    evt.set('type', 'showTabBar')
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  hideTabBar(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    DMPLogger.d(Tags.TABBAR, 'hideTabBar')
    const evt = new DMPMap()
    evt.set('type', 'hideTabBar')
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  setTabBarBadge(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const listLength = this.getTabBarListLength()
    if (listLength === 0) {
      this.invokeFailureCallback(callback, null, 'setTabBarBadge:fail tabBar not configured')
      return
    }
    const index: number = data.getNumber('index') ?? -1
    const text: string = data.get('text') ?? ''
    if (index < 0 || index >= listLength) {
      this.invokeFailureCallback(callback, null, `setTabBarBadge:fail invalid index ${index}`)
      return
    }
    DMPLogger.d(Tags.TABBAR, `setTabBarBadge: index=${index}, text=${text}`)
    const evt = new DMPMap()
    evt.set('type', 'setTabBarBadge')
    evt.set('index', index)
    evt.set('text', text)
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  removeTabBarBadge(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const listLength = this.getTabBarListLength()
    if (listLength === 0) {
      this.invokeFailureCallback(callback, null, 'removeTabBarBadge:fail tabBar not configured')
      return
    }
    const index: number = data.getNumber('index') ?? -1
    if (index < 0 || index >= listLength) {
      this.invokeFailureCallback(callback, null, `removeTabBarBadge:fail invalid index ${index}`)
      return
    }
    DMPLogger.d(Tags.TABBAR, `removeTabBarBadge: index=${index}`)
    const evt = new DMPMap()
    evt.set('type', 'removeTabBarBadge')
    evt.set('index', index)
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  showTabBarRedDot(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const listLength = this.getTabBarListLength()
    if (listLength === 0) {
      this.invokeFailureCallback(callback, null, 'showTabBarRedDot:fail tabBar not configured')
      return
    }
    const index: number = data.getNumber('index') ?? -1
    if (index < 0 || index >= listLength) {
      this.invokeFailureCallback(callback, null, `showTabBarRedDot:fail invalid index ${index}`)
      return
    }
    DMPLogger.d(Tags.TABBAR, `showTabBarRedDot: index=${index}`)
    const evt = new DMPMap()
    evt.set('type', 'showTabBarRedDot')
    evt.set('index', index)
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }

  hideTabBarRedDot(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const listLength = this.getTabBarListLength()
    if (listLength === 0) {
      this.invokeFailureCallback(callback, null, 'hideTabBarRedDot:fail tabBar not configured')
      return
    }
    const index: number = data.getNumber('index') ?? -1
    if (index < 0 || index >= listLength) {
      this.invokeFailureCallback(callback, null, `hideTabBarRedDot:fail invalid index ${index}`)
      return
    }
    DMPLogger.d(Tags.TABBAR, `hideTabBarRedDot: index=${index}`)
    const evt = new DMPMap()
    evt.set('type', 'hideTabBarRedDot')
    evt.set('index', index)
    this.emitTabBarEvent(evt)
    this.invokeSuccessCallback(callback, null)
  }
}
