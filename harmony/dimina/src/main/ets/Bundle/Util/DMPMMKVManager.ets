
import { MMKV } from '@tencent/mmkv'
import { DMPMap } from '../../Utils/DMPMap';
import { DMPFileManager } from './DMPFileManager';

const MMKV_TYPE_SUFFIX = '_mMKv7Yp3';

export class DMPMMKVManager {
  public mmkv: MMKV;
  private static instance: DMPMMKVManager

  static sharedInstance() {
    if (!DMPMMKVManager.instance) {
      DMPMMKVManager.instance = new DMPMMKVManager();
    }
    return DMPMMKVManager.instance;
  }

  constructor() {
    let sandboxPath = DMPFileManager.sharedInstance().sandboxPath;
    let rootPath = sandboxPath + '/mmkv'
    let cachePath = DMPFileManager.sharedInstance().cacheDir + '/mmkv';
    MMKV.initializeWithPath(rootPath, cachePath)

    let mmapID = 'dimina_mmkv_mmap_id';
    let backupRootDir = sandboxPath + '/mmkv_backup'
    this.mmkv = MMKV.backedUpMMKVWithID(mmapID, backupRootDir, MMKV.SINGLE_PROCESS_MODE, "DIMINA MMKV");
  }

  encode(key: string, value: number | string | boolean | Date | object): boolean {
    if (!this._isValidKey(key)) {
      return false;
    }

    const type = typeof value
    let success = false

    switch (typeof value) {
      case 'boolean': {
        success = this.mmkv.encodeBool(key, value)
        break;
      }

      case 'number': {
        success = this.mmkv.encodeDouble(key, value)
        break;
      }

      case 'object': {
        const v = JSON.stringify(value)
        if (v === undefined) {
          return false;
        }
        success = this.mmkv.encodeString(key, v)
        break;
      }

      case 'string': {
        success = this.mmkv.encodeString(key, value)
        break;
      }

      default:
        return false;
    }

    if (!success) {
      return false;
    }

    if (!this.mmkv.encodeString(this._genTypeKey(key), type)) {
      this._removeValueForKey(key)
      return false;
    }

    return true;
  }


  decode(key: string): DMPMap {
    const result = new DMPMap();
    let value: number | string | boolean | Date | object

    const type = this._isValidKey(key) ? this._getType(key) : ''
    switch (type) {
      case 'boolean': {
        value = this.mmkv.decodeBool(key) ?? false
        break;
      }
      case 'number': {
        value = this.mmkv.decodeDouble(key) ?? 0
        break;
      }
      case 'object': {
        let str: string = this.mmkv.decodeString(key, '') ?? ''
        try {
          value = str ? JSON.parse(str) : '';
        } catch (error) {
          value = str;
        }
        break;
      }
      case 'string': {
        value = this.mmkv.decodeString(key, '') ?? ''
        break;
      }
      default:
        value = '';
        break;
    }

    result.set('value', value);
    result.set('type', type);
    result.set('key', key);

    return result
  }

  remove(key: string): boolean {
    if (!this._isValidKey(key)) {
      return false;
    }

    const success = this._removeValueForKey(key)
    this._removeValueForKey(this._genTypeKey(key))
    return success;
  }

  clear() {
    this.mmkv.clearAll()
  }


  _getType(key: string): string {
    return this.mmkv.decodeString(this._genTypeKey(key), '') ?? '';
  }

  _genTypeKey(key: string) {
    return key + MMKV_TYPE_SUFFIX
  }

  totalSize(): number {
    return Number(this.mmkv.totalSize())
  }

  keys(): string[] {
    return this.mmkv.allKeys().filter((key: string) => !this._isTypeKey(key))
  }

  private _isTypeKey(key: string): boolean {
    return key.endsWith(MMKV_TYPE_SUFFIX)
  }

  private _isValidKey(key: string): boolean {
    return typeof key === 'string' && key.length > 0
  }

  private _removeValueForKey(key: string): boolean {
    try {
      this.mmkv.removeValueForKey(key)
      return true
    } catch (error) {
      return false
    }
  }

}
