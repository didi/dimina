import { DMPApp } from '../DApp/DMPApp';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPStack } from '../Utils/DMPStack';
import { DMPNavigatorDelegate } from './DMPNavigatorDelegate';
import { DMPPageRecord } from './DMPPageRecord';

export type PopListener = (destroyRecord?: DMPPageRecord, currentRecord?: DMPPageRecord) => void;

export type DomReadyListener = () => void;

export class DMPNavigatorManager {
  //导航器记录
  private _navigatorDelegateStack: DMPStack<DMPNavigatorDelegate> = new DMPStack()
  //页面记录
  private globalPageRecordStack: DMPStack<DMPPageRecord> = new DMPStack();
  //预加载记录
  private preLoadWebViewIdAndPageRecordMaps: Map<number, DMPPageRecord> = new Map();
  //页面记录
  private webViewIdAndPageRecordMaps: Map<number, DMPPageRecord> = new Map();
  app: DMPApp
  //页面销毁监控
  private popListeners: Set<PopListener> = new Set();

  constructor(app: DMPApp) {
    this.app = app;
  }

  findNavigatorByWebViewId(webViewId?: number): DMPNavigatorDelegate | undefined {
    if (!webViewId) {
      return undefined
    }
    for (let delegate of this._navigatorDelegateStack.data) {
      if (delegate.isContainsWebViewId(webViewId)) {
        return delegate;
      }
    }
    return undefined
  }

  getCurNavigator(): DMPNavigatorDelegate | undefined {
    return this._navigatorDelegateStack.peek()
  }

  getTopPageRecord() {
    return this.globalPageRecordStack.peek()
  }

  getPageRecordById(webViewId: number): DMPPageRecord | undefined {
    const record = this.webViewIdAndPageRecordMaps.get(webViewId);
    if (!record) {
      return this.preLoadWebViewIdAndPageRecordMaps.get(webViewId)
    }
    return record;
  }

  count() {
    return this._navigatorDelegateStack.size()
  }

  isEmpty() {
    return this._navigatorDelegateStack.isEmpty()
  }

  //只有退出和重启会调用
  clear() {
    this._navigatorDelegateStack.clear();
    this.globalPageRecordStack.clear();
  }

  pushNavigator(navigatorDelegate: DMPNavigatorDelegate): DMPNavigatorDelegate {
    DMPLogger.i(Tags.DMP_PAGE,
      `showStack  stackId->${navigatorDelegate.id}`)
    this.app?.showStack(navigatorDelegate.id)
    this._navigatorDelegateStack.push(navigatorDelegate)
    return navigatorDelegate;
  }

  //仅仅回退过程中当前navigator stack 为空被调用
  popNavigator(): DMPNavigatorDelegate | undefined {
    let navigatorDelegate = this._navigatorDelegateStack.pop()
    if (navigatorDelegate) {
      DMPLogger.i(Tags.DMP_PAGE,
        `hideStack  stackId->${navigatorDelegate?.id}`)
      this.app?.hideStack(navigatorDelegate?.id)
    }
    return navigatorDelegate;
  }

  //存储打开页面记录
  pushGlobalPageRecord(record: DMPPageRecord) {
    if (this.preLoadWebViewIdAndPageRecordMaps.has(record.webViewId)) {
      this.preLoadWebViewIdAndPageRecordMaps.delete(record.webViewId)
    }
    this.webViewIdAndPageRecordMaps.set(record.webViewId, record)
    this.globalPageRecordStack.push(record)
  }

  //存储预加载记录
  pushGlobalPreLoadPageRecord(record: DMPPageRecord) {
    this.preLoadWebViewIdAndPageRecordMaps.set(record.webViewId, record)
  }

  // Register tab page record (only to Map, not to stack)
  // Tab pages are managed by TabBarContainerView, not in navigator stack
  registerTabPageRecord(record: DMPPageRecord) {
    this.webViewIdAndPageRecordMaps.set(record.webViewId, record)
  }

  // Unregister tab page record from Map
  unregisterTabPageRecord(webViewId: number) {
    this.webViewIdAndPageRecordMaps.delete(webViewId)
  }

  popGlobalPageRecord() {
    const record = this.globalPageRecordStack.pop()
    if (record) {
      this.webViewIdAndPageRecordMaps.delete(record.webViewId)
    }
  }

  registerPopListener(listener: PopListener): void {
    if (!this.popListeners.has(listener)) {
      this.popListeners.add(listener);
    }
  }

  unregisterPopListener(listener: PopListener): void {
    this.popListeners.delete(listener)
  }

  //页面返回监控
  notifyPopListener() {
    for (let listener of this.popListeners) {
      const currentRecord = this.globalPageRecordStack.peek()
      listener(currentRecord)
    }
  }
}