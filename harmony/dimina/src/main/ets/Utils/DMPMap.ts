import { ArrayList } from '@kit.ArkTS';

export class DMPMap {
  private _entry: { [key: string]: any } = {};

  constructor(data?: { [key: string]: any }) {
    if (data) {
      this._entry = data;
    }
  }

  get(key: string): any {
    return this._entry[key];
  }

  set(key: string, value: any): void {
    this._entry[key] = value;
  }

  toJSON(): { [key: string]: any } {
    return this._entry;
  }

  toMap<K, V>(): Map<K, V> {
    let map = new Map<K, V>();
    const arr = Object.keys(this._entry)
    arr.forEach((key, _, __) => {
      map.set(key as K, this._entry[key])
    })
    return map;
  }

  toArray<T>(): T[] {
    const arr = Object.keys(this._entry)
      .filter(key => key !== 'length')
      .map(key => this._entry[key]);
    return arr;
  }

  toArrayList<T>(): ArrayList<T> {
    const arrayList = new ArrayList<T>();
    const arr = Object.keys(this._entry)
      .filter(key => key !== 'length')
    arr.forEach((key, _, __) => {
      arrayList.add(this._entry[key] as T)
    })
    return arrayList;
  }

  toStr(): string {
    return JSON.stringify(this)
  }

  static createFromObject(object: Object) {
    return new DMPMap(object)
  }

  public toObject<T>(): T {
    return this._entry as T
  }

  setAll(data: DMPMap): void {
    this._entry = {
      ...this._entry,
      ...data._entry
    };
  }


  public static toArray<T>(obj: object): T[] {
    const arr = Object.keys(obj)
      .filter(key => key !== 'length')
      .map(key => obj[key]);
    return arr;
  }

  public static toArrayList<T>(obj: object): ArrayList<T> {
    const arrayList = new ArrayList<T>();
    const arr = Object.keys(obj)
      .filter(key => key !== 'length')
    arr.forEach((key, _, __) => {
      arrayList.add(obj[key] as T)
    })
    return arrayList;
  }

  public static toMap<K, V>(obj: object): Map<K, V> {
    let map = new Map<K, V>();
    const arr = Object.keys(obj)
    arr.forEach((key, _, __) => {
      map.set(key as K, obj[key])
    })
    return map;
  }

  public static getClassName(obj: object): string {
    return obj.constructor.name;
  }

  hasKey(key: string): boolean {
    return this.get(key) != undefined
  }

  /**
   * True key-presence check (distinguishes a missing key from a present
   * key whose value happens to be `null`/`undefined`), unlike `hasKey`
   * above which is a truthiness-ish check on the value. Added specifically
   * for callers that need wire-contract "does the field exist" routing
   * (e.g. WebSocket's task-vs-legacy-mode dispatch on `socketId`) without
   * changing `hasKey`'s existing semantics for its other ~20 call sites.
   */
  hasOwnKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._entry, key)
  }

  getString(key: string): string | undefined {
    return this.get(key);
  }

  getNumber(key: string): number | undefined {
    return this.get(key);
  }

  getBoolean(key: string): boolean | undefined {
    return this.get(key);
  }

  getObject(key: string): object | undefined {
    return this.get(key);
  }

  getArray<T>(key: string): Array<T> | undefined {
    return this.get(key);
  }

  public static createFromDMPMap(dmpMap: DMPMap): DMPMap {
    const result = new DMPMap();
    result.setAll(dmpMap)
    return result;
  }

  public static createFromString(data: string): DMPMap {
    let o = JSON.parse(data)
    return new DMPMap(o)
  }
}
