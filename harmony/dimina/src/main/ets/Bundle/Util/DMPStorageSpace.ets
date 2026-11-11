import { DMPMMKVManager } from './DMPMMKVManager';

interface DMPStoragePayload {
  data: string;
  dataType: string;
}
export interface DMPStorageWire extends DMPStoragePayload {
  entrySize: number;
}
export interface DMPStorageInfo {
  keys: string[];
  currentSize: number;
  limitSize: number;
}
interface DMPStorageResult {
  __diminaStorageResult: number;
  record?: DMPStorageWire;
  value?: object | string | number | boolean | null;
}
interface DMPStorageRecord {
  version: number;
  deleted?: boolean;
  value?: object | string | number | boolean | null;
  wire?: DMPStorageWire;
}
export class DMPStorageSpace {
  private manager: DMPMMKVManager;

  constructor(manager: DMPMMKVManager) {
    this.manager = manager;
  }

  private record(key: string): DMPStorageRecord | undefined {
    const encoded = this.manager.readStorageRecord(key);
    if (encoded) {
      try {
        const record = JSON.parse(encoded) as DMPStorageRecord;
        if (record.version === 1) return record;
      } catch (_) { /* Fall back to the readable legacy record. */ }
    }
    const legacy = this.manager.decode(key);
    return legacy.getString('type') ? { version: 1, value: legacy.get('value') } : undefined;
  }

  private normalize(key: string, value: object | string | number | boolean | null | undefined,
    supplied?: DMPStorageWire): DMPStorageWire {
    let dataType: string;
    let data: string;
    if (supplied && typeof supplied.data === 'string' && typeof supplied.dataType === 'string') {
      dataType = supplied.dataType;
      data = supplied.data;
    } else {
      if (value === undefined) {
        dataType = 'Undefined'; data = 'undefined';
      } else if (value === null) {
        dataType = 'Null'; data = 'null';
      } else if (typeof value === 'string') {
        dataType = 'String'; data = value;
      } else if (typeof value === 'number') {
        dataType = 'Number'; data = value.toString();
      } else if (typeof value === 'boolean') {
        dataType = 'Boolean'; data = value.toString();
      } else if (Array.isArray(value)) {
        dataType = 'Array'; data = JSON.stringify(value);
      } else if (value instanceof Date) {
        dataType = 'Date'; data = value.getTime().toString();
      } else if (value instanceof RegExp) {
        dataType = 'RegExp'; data = '';
      } else {
        dataType = 'Object'; data = JSON.stringify(value);
      }
    }
    const payload: DMPStoragePayload = { data, dataType };
    return { data, dataType, entrySize: JSON.stringify(key).length + 1 + JSON.stringify(payload).length };
  }

  private records(): Map<string, DMPStorageRecord> {
    const records = new Map<string, DMPStorageRecord>();
    for (const key of this.manager.storageRecordKeys()) {
      const encoded = this.manager.readStorageRecord(key);
      if (!encoded) continue;
      try {
        const record = JSON.parse(encoded) as DMPStorageRecord;
        if (record.version === 1) records.set(key, record);
      } catch (_) { /* Corrupt records do not hide a readable legacy value. */ }
    }
    for (const key of this.manager.keys()) {
      if (records.has(key)) continue;
      const legacy = this.manager.decode(key);
      if (legacy.getString('type')) records.set(key, { version: 1, value: legacy.get('value') });
    }
    return records;
  }

  private spaceSize(records: Map<string, DMPStorageRecord>): number {
    let total = 2;
    let count = 0;
    records.forEach((record, key) => {
      if (record.deleted) return;
      total += this.normalize(key, record.value, record.wire).entrySize;
      count++;
    });
    return total + Math.max(0, count - 1);
  }

  set(key: string, value: object | string | number | boolean | null | undefined, wire?: DMPStorageWire): boolean {
    if (!key) return false;
    const record: DMPStorageRecord = { version: 1, value, wire: this.normalize(key, value, wire) };
    const records = this.records();
    records.set(key, record);
    if (this.spaceSize(records) + 6 > 10 * 1024 * 1024) throw new Error('exceed storage max size 10Mb');
    // No await or callback occurs between validation and this single-record MMKV commit.
    return this.manager.writeStorageRecord(key, JSON.stringify(record));
  }

  get(key: string, wire: boolean): object | string | number | boolean | null | undefined {
    const record = this.record(key);
    if (!record || record.deleted) return undefined;
    if (!wire) return record.value;
    const result: DMPStorageResult = { __diminaStorageResult: 1 };
    if (record.wire) result.record = record.wire;
    else result.value = record.value;
    return result;
  }

  has(key: string): boolean {
    const record = this.record(key);
    return record !== undefined && !record.deleted;
  }

  remove(key: string): boolean {
    if (!key) return false;
    const record: DMPStorageRecord = { version: 1, deleted: true };
    return this.manager.writeStorageRecord(key, JSON.stringify(record));
  }

  clear(): void { this.manager.clearStorageSpace(); }

  info(): DMPStorageInfo {
    const records = this.records();
    const keys: string[] = [];
    records.forEach((record, key) => { if (!record.deleted) keys.push(key); });
    return { keys, currentSize: Math.ceil(this.spaceSize(records) / 1024), limitSize: 10240 };
  }
}
