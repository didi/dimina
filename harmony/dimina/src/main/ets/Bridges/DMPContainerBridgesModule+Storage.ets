import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPMMKVManager } from '../Bundle/Util/DMPMMKVManager'
import { DMPMap } from '../Utils/DMPMap';

export class DMPContainerBridgesModuleStorage extends DMPContainerBridgesModule {
  private getStorageManager(): DMPMMKVManager {
    const appId = this.appData.appId || this.app?.appConfig?.appId || 'default';
    return DMPMMKVManager.sharedInstance(appId);
  }

  getExportMethods(): string[] {
    return [
      'setStorageSync',
      'setStorage',
      'getStorageSync',
      'getStorage',
      'removeStorageSync',
      'removeStorage',
      'clearStorageSync',
      'clearStorage',
      'getStorageInfoSync',
      'getStorageInfo',
    ];
  }

  setStorage(data: DMPMap, callback: DMPBridgeCallback) {
    const mgr = this.getStorageManager()
    const value: number | string | boolean | Date | object = data.get('data')
    const key: string = data.get('key')
    const success = mgr.encode(key, value)
    if (success) {
      this.invokeSuccessCallback(callback, undefined);
    } else {
      this.invokeFailureCallback(callback, undefined, '');
    }
  }

  // 这里的入参根据微信接口定义的变化而变化，框架只做了透传，不修改数据结构
  // setStorageSync 入参不是对象，而是两个参数，这里 data 是 array 类型，所以可以使用 index 访问
  setStorageSync(data: DMPMap, callback: DMPBridgeCallback): boolean {
    const params: object = data.toObject()
    const key: string = params[0]
    const value: number | string | boolean | Date | object = params[1]
    const mgr = this.getStorageManager()
    return mgr.encode(key, value)
  }

  getStorageSync(data: string | DMPMap, callback: DMPBridgeCallback): number | string | boolean | Date | object {
    const key: string = this._getKey(data)
    return this._getStorage(key);
  }

  getStorage(data: DMPMap, callback: DMPBridgeCallback) {
    const result: DMPMap = new DMPMap()
    result.set('data', this._getStorage(this._getKey(data)));
    this.invokeSuccessCallback(callback, result);
  }

  removeStorageSync(data: string | DMPMap, callback: DMPBridgeCallback): boolean {
    const key: string = this._getKey(data)
    const mgr = this.getStorageManager()
    return mgr.remove(key)
  }

  removeStorage(data: DMPMap, callback: DMPBridgeCallback) {
    const key: string = this._getKey(data)
    const mgr = this.getStorageManager()
    if (mgr.remove(key)) {
      this.invokeSuccessCallback(callback, null);
    } else {
      this.invokeFailureCallback(callback, undefined, '');
    }
  }

  clearStorageSync(data: DMPMap, callback: DMPBridgeCallback): boolean {
    const mgr = this.getStorageManager()
    mgr.clear()
    return true
  }

  clearStorage(data: DMPMap, callback: DMPBridgeCallback) {
    const mgr = this.getStorageManager()
    mgr.clear()
  }

  _getStorage(key: string): number | string | boolean | Date | object {
    const mgr = this.getStorageManager()
    return mgr.decode(key).get('value');
  }

  private _getKey(data: string | DMPMap): string {
    if (typeof data === 'string') {
      return data
    }
    return data.getString('key') ?? ''
  }

  getStorageInfoSync(data: DMPMap, callback: DMPBridgeCallback): object {
    return this._getStorageInfo();
  }

  getStorageInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const result = this._getStorageInfo()
    this.invokeSuccessCallback(callback, result);
  }

  _getStorageInfo(): DMPMap {
    const mgr = this.getStorageManager()

    const currentSize = mgr.totalSize()
    const keys = mgr.keys() as Array<string>

    let result = new Object() as object

    const storageTotalLimit = 10 * 1024 * 1024; // 所有数据存储上限为 10MB
    // const DMPStorageLengthLimit = 1024 * 1024; // 单个 key 允许存储的最大数据长度为 1MB

    result['keys'] = keys;
    result['currentSize'] = currentSize;
    result['limitSize'] = storageTotalLimit;

    return DMPMap.createFromObject(result);
  }
}
