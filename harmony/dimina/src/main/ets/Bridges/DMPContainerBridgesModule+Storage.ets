import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { DMPMMKVManager } from '../Bundle/Util/DMPMMKVManager';
import { DMPStorageSpace, DMPStorageWire } from '../Bundle/Util/DMPStorageSpace';
import { DMPMap } from '../Utils/DMPMap';

interface DMPStorageOptions { __diminaStorageWire?: DMPStorageWire; }

export class DMPContainerBridgesModuleStorage extends DMPContainerBridgesModule {
  private space(): DMPStorageSpace {
    return new DMPStorageSpace(DMPMMKVManager.sharedInstance(
      this.appData.appId || this.app?.appConfig?.appId || 'default'));
  }

  getExportMethods(): string[] {
    return ['setStorageSync', 'setStorage', 'getStorageSync', 'getStorage', 'removeStorageSync',
      'removeStorage', 'clearStorageSync', 'clearStorage', 'getStorageInfoSync', 'getStorageInfo'];
  }

  setStorage(data: DMPMap, callback: DMPBridgeCallback): void {
    try {
      const success = this.space().set(data.getString('key') ?? '', data.get('data'), data.get('__diminaStorageWire'));
      if (!success) throw new Error('storage write failed');
      this.invokeSuccessCallback(callback, new DMPMap({ errMsg: 'setStorage:ok' }));
    } catch (error) {
      this.invokeFailureCallback(callback, null, 'setStorage:fail ' + (error as Error).message);
    }
  }

  setStorageSync(data: DMPMap, _callback: DMPBridgeCallback): object | void {
    const params = data.toArray<object | string | number | boolean | null>();
    const wire = (params[2] as DMPStorageOptions)?.__diminaStorageWire;
    try {
      if (!this.space().set(params[0] as string, params[1], wire)) throw new Error('storage write failed');
    } catch (error) { return { __diminaStorageError: (error as Error).message }; }
  }

  getStorageSync(data: string | DMPMap, _callback: DMPBridgeCallback): object | string | number | boolean | null | undefined {
    const space = this.space();
    const key = this.key(data);
    if (!space.has(key)) return '';
    return space.get(key, typeof data !== 'string' && data.getBoolean('__diminaStorageWire') === true);
  }

  getStorage(data: DMPMap, callback: DMPBridgeCallback): void {
    const space = this.space();
    const key = this.key(data);
    if (!space.has(key)) {
      this.invokeFailureCallback(callback, null, 'getStorage:fail data not found');
      return;
    }
    this.invokeSuccessCallback(callback, new DMPMap({
      data: space.get(key, data.getBoolean('__diminaStorageWire') === true), errMsg: 'getStorage:ok',
    }));
  }

  removeStorageSync(data: string | DMPMap, _callback: DMPBridgeCallback): void {
    this.space().remove(this.key(data));
  }

  removeStorage(data: DMPMap, callback: DMPBridgeCallback): void {
    if (this.space().remove(this.key(data))) this.invokeSuccessCallback(callback, new DMPMap({ errMsg: 'removeStorage:ok' }));
    else this.invokeFailureCallback(callback, null, 'removeStorage:fail');
  }

  clearStorageSync(_data: DMPMap, _callback: DMPBridgeCallback): void { this.space().clear(); }

  clearStorage(_data: DMPMap, callback: DMPBridgeCallback): void {
    this.space().clear();
    this.invokeSuccessCallback(callback, new DMPMap({ errMsg: 'clearStorage:ok' }));
  }

  private key(data: string | DMPMap): string {
    return typeof data === 'string' ? data : data.getString('key') ?? '';
  }

  getStorageInfoSync(_data: DMPMap, _callback: DMPBridgeCallback): object {
    return new DMPMap(this.space().info());
  }

  getStorageInfo(_data: DMPMap, callback: DMPBridgeCallback): void {
    this.invokeSuccessCallback(callback, new DMPMap({ ...this.space().info(), errMsg: 'getStorageInfo:ok' }));
  }
}
