import { DMPMMKVManager } from './DMPMMKVManager';

export interface DMPStorageWire {
  data: string;
  dataType: string;
  entrySize: number;
}
interface DMPStorageRecord {
  version: number;
  deleted?: boolean;
  value?: object | string | number | boolean | null;
  wire?: DMPStorageWire;
}
export class DMPStorageSpace {
  constructor(private manager: DMPMMKVManager) {}

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
      dataType = Object.prototype.toString.call(value).slice(8, -1);
      if (dataType === 'Object' || dataType === 'Array') data = JSON.stringify(value);
      else if (dataType === 'Date') data = (value as Date).getTime().toString();
      else if (dataType === 'Undefined') data = 'undefined';
      else if (dataType === 'Null') data = 'null';
      else if (['String', 'Number', 'Boolean'].includes(dataType)) data = String(value);
      else data = '';
    }
    return { data, dataType, entrySize: JSON.stringify(key).length + 1 + JSON.stringify({ data, dataType }).length };
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
    if (record.wire) return { __diminaStorageResult: 1, record: record.wire };
    return { __diminaStorageResult: 1, value: record.value };
  }

  has(key: string): boolean {
    const record = this.record(key);
    return record !== undefined && !record.deleted;
  }

  remove(key: string): boolean {
    if (!key) return false;
    return this.manager.writeStorageRecord(key, JSON.stringify({ version: 1, deleted: true }));
  }

  clear(): void { this.manager.clearStorageSpace(); }

  info(): object {
    const records = this.records();
    const keys: string[] = [];
    records.forEach((record, key) => { if (!record.deleted) keys.push(key); });
    return { keys, currentSize: Math.ceil(this.spaceSize(records) / 1024), limitSize: 10240 };
  }
}
