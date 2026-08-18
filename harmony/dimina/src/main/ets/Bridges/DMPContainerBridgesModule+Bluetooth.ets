import { abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { access, ble, constant } from '@kit.ConnectivityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil';
import { DMPMap } from '../Utils/DMPMap';
import { DMPContextUtils } from '../Utils/DMPContextUtils';

const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BLUETOOTH_PERMISSION: Permissions = 'ohos.permission.ACCESS_BLUETOOTH';

class BluetoothPendingCall {
  name: string;
  callback: DMPBridgeCallback;
  timeoutId: number | undefined;

  constructor(name: string, callback: DMPBridgeCallback) {
    this.name = name;
    this.callback = callback;
    this.timeoutId = undefined;
  }
}

class BluetoothGattConnection {
  deviceId: string;
  device: ble.GattClientDevice;
  services: ble.GattService[] = [];
  mtu: number = 23;

  constructor(deviceId: string, device: ble.GattClientDevice) {
    this.deviceId = deviceId;
    this.device = device;
  }
}

class BluetoothAdvertisementData {
  serviceUuids: string[] = [];
  serviceData: DMPMap = new DMPMap();
}

/** WeChat-compatible Bluetooth adapter and BLE central bridge for HarmonyOS. */
export class DMPContainerBridgesModuleBluetooth extends DMPContainerBridgesModule {
  private initialized: boolean = false;
  private scanning: boolean = false;
  private scanSubscribed: boolean = false;
  private stateSubscribed: boolean = false;
  private allowDuplicates: boolean = false;
  private foundDevices: Map<string, DMPMap> = new Map();
  private connections: Map<string, BluetoothGattConnection> = new Map();
  private pending: Map<string, BluetoothPendingCall> = new Map();

  private adapterListeners: Map<string, DMPBridgeCallback> = new Map();
  private deviceListeners: Map<string, DMPBridgeCallback> = new Map();
  private connectionListeners: Map<string, DMPBridgeCallback> = new Map();
  private characteristicListeners: Map<string, DMPBridgeCallback> = new Map();
  private mtuListeners: Map<string, DMPBridgeCallback> = new Map();

  private stateChangeCallback = (state: access.BluetoothState): void => {
    const available = this.isAvailableState(state);
    const result = new DMPMap();
    result.set('available', available);
    result.set('discovering', available && this.scanning);
    this.emit(this.adapterListeners, result);
  };

  private scanCallback = (results: Array<ble.ScanResult>): void => {
    const changed: object[] = [];
    results.forEach((scanResult: ble.ScanResult) => {
      const isNew = !this.foundDevices.has(scanResult.deviceId);
      const device = this.scanResult(scanResult);
      this.foundDevices.set(scanResult.deviceId, device);
      if (isNew || this.allowDuplicates) {
        changed.push(device.toJSON());
      }
    });
    if (changed.length > 0) {
      const result = new DMPMap();
      result.set('devices', changed);
      this.emit(this.deviceListeners, result);
    }
  };

  getExportMethods(): string[] {
    return [
      'openBluetoothAdapter', 'closeBluetoothAdapter', 'getBluetoothAdapterState',
      'startBluetoothDevicesDiscovery', 'stopBluetoothDevicesDiscovery',
      'getBluetoothDevices', 'getConnectedBluetoothDevices',
      'onBluetoothAdapterStateChange', 'offBluetoothAdapterStateChange',
      'onBluetoothDeviceFound', 'offBluetoothDeviceFound',
      'createBLEConnection', 'closeBLEConnection',
      'getBLEDeviceServices', 'getBLEDeviceCharacteristics',
      'readBLECharacteristicValue', 'writeBLECharacteristicValue',
      'notifyBLECharacteristicValueChange', 'getBLEDeviceRSSI',
      'setBLEMTU', 'getBLEMTU',
      'onBLEConnectionStateChange', 'offBLEConnectionStateChange',
      'onBLECharacteristicValueChange', 'offBLECharacteristicValueChange',
      'onBLEMTUChange', 'offBLEMTUChange',
      'isBluetoothDevicePaired', 'makeBluetoothPair'
    ];
  }

  openBluetoothAdapter(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'openBluetoothAdapter';
    if (data.getString('mode') === 'peripheral') {
      this.failure(name, callback, 10009, 'peripheral mode is not supported');
      return;
    }
    const manager = abilityAccessCtrl.createAtManager();
    manager.requestPermissionsFromUser(DMPContextUtils.getUIAbilityContext(), [BLUETOOTH_PERMISSION])
      .then((result) => {
        if (result.authResults.length > 0 && result.authResults[0] !== 0) {
          this.failure(name, callback, 10001, 'permission denied');
          return;
        }
        this.finishOpen(callback);
      })
      .catch((error: BusinessError) => this.failure(name, callback, 10001, error.message));
  }

  private finishOpen(callback: DMPBridgeCallback): void {
    const name = 'openBluetoothAdapter';
    try {
      this.initialized = true;
      if (!this.stateSubscribed) {
        access.on('stateChange', this.stateChangeCallback);
        this.stateSubscribed = true;
      }
      if (this.isAvailable()) {
        this.success(name, callback);
      } else {
        this.failure(name, callback, 10001, 'not available');
      }
    } catch (error) {
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  closeBluetoothAdapter(_data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'closeBluetoothAdapter';
    if (!this.ensureInitialized(name, callback)) return;
    this.stopScan();
    this.connections.forEach((connection: BluetoothGattConnection) => {
      try {
        connection.device.disconnect();
        connection.device.close();
      } catch (_) {}
    });
    this.connections.clear();
    this.pending.forEach((pending: BluetoothPendingCall) => {
      if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
      this.failure(pending.name, pending.callback, 10006, 'no connection');
    });
    this.pending.clear();
    this.foundDevices.clear();
    this.initialized = false;
    this.success(name, callback);
  }

  getBluetoothAdapterState(_data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBluetoothAdapterState';
    if (!this.ensureInitialized(name, callback)) return;
    const result = new DMPMap();
    result.set('available', this.isAvailable());
    result.set('discovering', this.isAvailable() && this.scanning);
    this.success(name, callback, result);
  }

  startBluetoothDevicesDiscovery(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'startBluetoothDevicesDiscovery';
    if (!this.ensureAvailable(name, callback)) return;
    if (this.scanning) {
      this.success(name, callback);
      return;
    }
    try {
      if (!this.scanSubscribed) {
        ble.on('BLEDeviceFind', this.scanCallback);
        this.scanSubscribed = true;
      }
      const filters: ble.ScanFilter[] = [];
      const services = data.getArray<string>('services') ?? [];
      services.forEach((serviceUuid: string) => {
        const filter: ble.ScanFilter = { serviceUuid: this.canonicalUuid(serviceUuid) };
        filters.push(filter);
      });
      this.allowDuplicates = data.getBoolean('allowDuplicatesKey') ?? false;
      const powerLevel = data.getString('powerLevel') ?? 'medium';
      let dutyMode = ble.ScanDuty.SCAN_MODE_BALANCED;
      if (powerLevel === 'low') dutyMode = ble.ScanDuty.SCAN_MODE_LOW_POWER;
      if (powerLevel === 'high') dutyMode = ble.ScanDuty.SCAN_MODE_LOW_LATENCY;
      const options: ble.ScanOptions = {
        interval: Math.max(data.getNumber('interval') ?? 0, 0),
        dutyMode: dutyMode,
        matchMode: ble.MatchMode.MATCH_MODE_AGGRESSIVE
      };
      ble.startBLEScan(filters, options);
      this.scanning = true;
      this.success(name, callback);
    } catch (error) {
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  stopBluetoothDevicesDiscovery(_data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'stopBluetoothDevicesDiscovery';
    if (!this.ensureInitialized(name, callback)) return;
    this.stopScan();
    this.success(name, callback);
  }

  getBluetoothDevices(_data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBluetoothDevices';
    if (!this.ensureInitialized(name, callback)) return;
    const result = new DMPMap();
    result.set('devices', Array.from(this.foundDevices.values()).map((device: DMPMap) => device.toJSON()));
    this.success(name, callback, result);
  }

  getConnectedBluetoothDevices(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getConnectedBluetoothDevices';
    if (!this.ensureAvailable(name, callback)) return;
    try {
      const devices: object[] = [];
      const requested = (data.getArray<string>('services') ?? []).map((uuid: string) => this.canonicalUuid(uuid));
      ble.getConnectedBLEDevices().forEach((deviceId: string) => {
        const found = this.foundDevices.get(deviceId);
        const connection = this.connections.get(deviceId);
        const serviceUuids = found?.getArray<string>('advertisServiceUUIDs') ?? [];
        const matches = requested.length === 0 || requested.some((uuid: string) =>
          serviceUuids.some((item: string) => this.canonicalUuid(item) === uuid) ||
          (connection?.services.some((service: ble.GattService) => this.canonicalUuid(service.serviceUuid) === uuid) ?? false)
        );
        if (!matches) return;
        if (found) {
          devices.push(found.toJSON());
        } else {
          const device = new DMPMap();
          device.set('deviceId', deviceId);
          device.set('name', '');
          devices.push(device.toJSON());
        }
      });
      const result = new DMPMap();
      result.set('devices', devices);
      this.success(name, callback, result);
    } catch (error) {
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  onBluetoothAdapterStateChange(data: DMPMap, callback: DMPBridgeCallback): void {
    this.addListener(this.adapterListeners, data, callback);
  }

  offBluetoothAdapterStateChange(data: DMPMap, _callback: DMPBridgeCallback): void {
    this.removeListener(this.adapterListeners, data);
  }

  onBluetoothDeviceFound(data: DMPMap, callback: DMPBridgeCallback): void {
    this.addListener(this.deviceListeners, data, callback);
  }

  offBluetoothDeviceFound(data: DMPMap, _callback: DMPBridgeCallback): void {
    this.removeListener(this.deviceListeners, data);
  }

  onBLEConnectionStateChange(data: DMPMap, callback: DMPBridgeCallback): void {
    this.addListener(this.connectionListeners, data, callback);
  }

  offBLEConnectionStateChange(data: DMPMap, _callback: DMPBridgeCallback): void {
    this.removeListener(this.connectionListeners, data);
  }

  onBLECharacteristicValueChange(data: DMPMap, callback: DMPBridgeCallback): void {
    this.addListener(this.characteristicListeners, data, callback);
  }

  offBLECharacteristicValueChange(data: DMPMap, _callback: DMPBridgeCallback): void {
    this.removeListener(this.characteristicListeners, data);
  }

  onBLEMTUChange(data: DMPMap, callback: DMPBridgeCallback): void {
    this.addListener(this.mtuListeners, data, callback);
  }

  offBLEMTUChange(data: DMPMap, _callback: DMPBridgeCallback): void {
    this.removeListener(this.mtuListeners, data);
  }

  createBLEConnection(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'createBLEConnection';
    if (!this.ensureAvailable(name, callback)) return;
    const deviceId = this.requireString(data, 'deviceId', name, callback);
    if (!deviceId) return;
    if (this.connections.has(deviceId)) {
      this.success(name, callback);
      return;
    }
    try {
      const device = ble.createGattClientDevice(deviceId);
      const connection = new BluetoothGattConnection(deviceId, device);
      this.connections.set(deviceId, connection);
      this.registerGattEvents(connection);
      const pending = new BluetoothPendingCall(name, callback);
      this.pending.set(deviceId, pending);
      device.connect();
      const timeout = data.getNumber('timeout') ?? 0;
      if (timeout > 0) {
        pending.timeoutId = setTimeout((): void => {
          if (this.pending.get(deviceId) !== pending) return;
          this.pending.delete(deviceId);
          this.connections.delete(deviceId);
          try { device.disconnect(); device.close(); } catch (_) {}
          this.failure(name, callback, 10012, 'operate time out');
        }, timeout);
      }
    } catch (error) {
      this.connections.delete(deviceId);
      this.pending.delete(deviceId);
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  closeBLEConnection(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'closeBLEConnection';
    if (!this.ensureInitialized(name, callback)) return;
    const deviceId = this.requireString(data, 'deviceId', name, callback);
    if (!deviceId) return;
    const connection = this.connections.get(deviceId);
    if (!connection) {
      this.failure(name, callback, 10002, 'no device');
      return;
    }
    try {
      connection.device.disconnect();
      connection.device.close();
      this.connections.delete(deviceId);
      const pending = this.pending.get(deviceId);
      if (pending?.timeoutId !== undefined) clearTimeout(pending.timeoutId);
      this.pending.delete(deviceId);
      if (pending) this.failure(pending.name, pending.callback, 10006, 'no connection');
      this.emitConnection(deviceId, false);
      this.success(name, callback);
    } catch (error) {
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  getBLEDeviceServices(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBLEDeviceServices';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    connection.device.getServices()
      .then((services: ble.GattService[]) => {
        connection.services = services;
        const result = new DMPMap();
        result.set('services', services.map((service: ble.GattService) => {
          const item = new DMPMap();
          item.set('uuid', service.serviceUuid.toUpperCase());
          item.set('isPrimary', service.isPrimary);
          return item.toJSON();
        }));
        this.success(name, callback, result);
      })
      .catch((error: BusinessError) => this.failure(name, callback, this.errorCode(error), error.message));
  }

  getBLEDeviceCharacteristics(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBLEDeviceCharacteristics';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const service = this.findService(connection, data);
    if (!service) {
      this.failure(name, callback, 10004, 'no service');
      return;
    }
    const result = new DMPMap();
    result.set('characteristics', service.characteristics.map((characteristic: ble.BLECharacteristic) => {
      const properties = characteristic.properties;
      const props = new DMPMap();
      props.set('read', properties?.read ?? false);
      props.set('write', properties?.write ?? false);
      props.set('writeNoResponse', properties?.writeNoResponse ?? false);
      props.set('notify', properties?.notify ?? false);
      props.set('indicate', properties?.indicate ?? false);
      const item = new DMPMap();
      item.set('uuid', characteristic.characteristicUuid.toUpperCase());
      item.set('properties', props.toJSON());
      return item.toJSON();
    }));
    this.success(name, callback, result);
  }

  readBLECharacteristicValue(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'readBLECharacteristicValue';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const characteristic = this.findCharacteristic(connection, data, name, callback);
    if (!characteristic) return;
    if (!(characteristic.properties?.read ?? false)) {
      this.failure(name, callback, 10007, 'property not support');
      return;
    }
    connection.device.readCharacteristicValue(characteristic)
      .then((value: ble.BLECharacteristic) => {
        this.emitCharacteristic(connection.deviceId, value);
        this.success(name, callback);
      })
      .catch((error: BusinessError) => this.failure(name, callback, this.errorCode(error), error.message));
  }

  writeBLECharacteristicValue(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'writeBLECharacteristicValue';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const characteristic = this.findCharacteristic(connection, data, name, callback);
    if (!characteristic) return;
    const value = this.decodeArrayBuffer(data.get('value'));
    if (!value) {
      this.failure(name, callback, 10013, 'invalid_data');
      return;
    }
    const withoutResponse = data.getString('writeType') === 'writeNoResponse';
    if (withoutResponse && !(characteristic.properties?.writeNoResponse ?? false)) {
      this.failure(name, callback, 10007, 'property not support');
      return;
    }
    if (!withoutResponse && !(characteristic.properties?.write ?? false)) {
      this.failure(name, callback, 10007, 'property not support');
      return;
    }
    characteristic.characteristicValue = value;
    const writeType = withoutResponse ? ble.GattWriteType.WRITE_NO_RESPONSE : ble.GattWriteType.WRITE;
    connection.device.writeCharacteristicValue(characteristic, writeType)
      .then(() => this.success(name, callback))
      .catch((error: BusinessError) => this.failure(name, callback, this.errorCode(error), error.message));
  }

  notifyBLECharacteristicValueChange(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'notifyBLECharacteristicValueChange';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const characteristic = this.findCharacteristic(connection, data, name, callback);
    if (!characteristic) return;
    const enabled = data.getBoolean('state') ?? true;
    if (enabled && !(characteristic.properties?.notify ?? false) && !(characteristic.properties?.indicate ?? false)) {
      this.failure(name, callback, 10007, 'property not support');
      return;
    }
    connection.device.setCharacteristicChangeNotification(characteristic, enabled)
      .then(() => this.success(name, callback))
      .catch((error: BusinessError) => this.failure(name, callback, this.errorCode(error), error.message));
  }

  getBLEDeviceRSSI(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBLEDeviceRSSI';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    connection.device.getRssiValue()
      .then((rssi: number) => {
        const result = new DMPMap();
        result.set('RSSI', rssi);
        this.success(name, callback, result);
      })
      .catch((error: BusinessError) => this.failure(name, callback, this.errorCode(error), error.message));
  }

  setBLEMTU(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'setBLEMTU';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const mtu = data.getNumber('mtu') ?? 23;
    if (mtu < 23 || mtu > 511) {
      this.failure(name, callback, 10013, 'invalid_data');
      return;
    }
    try {
      connection.device.setBLEMtuSize(mtu);
      connection.mtu = mtu;
      const result = new DMPMap();
      result.set('mtu', mtu);
      this.success(name, callback, result);
    } catch (error) {
      this.failure(name, callback, this.errorCode(error), this.errorMessage(error));
    }
  }

  getBLEMTU(data: DMPMap, callback: DMPBridgeCallback): void {
    const name = 'getBLEMTU';
    const connection = this.requireConnection(data, name, callback);
    if (!connection) return;
    const result = new DMPMap();
    result.set('mtu', connection.mtu);
    this.success(name, callback, result);
  }

  isBluetoothDevicePaired(_data: DMPMap, callback: DMPBridgeCallback): void {
    this.failure('isBluetoothDevicePaired', callback, 10009, 'system not support');
  }

  makeBluetoothPair(_data: DMPMap, callback: DMPBridgeCallback): void {
    this.failure('makeBluetoothPair', callback, 10009, 'system not support');
  }

  private registerGattEvents(connection: BluetoothGattConnection): void {
    connection.device.on('BLEConnectionStateChange', (state: ble.BLEConnectionChangeState): void => {
      const connected = state.state === constant.ProfileConnectionState.STATE_CONNECTED;
      if (connected) {
        const pending = this.pending.get(connection.deviceId);
        if (pending?.name === 'createBLEConnection') {
          if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
          this.pending.delete(connection.deviceId);
          this.success(pending.name, pending.callback);
        }
      } else {
        const pending = this.pending.get(connection.deviceId);
        if (pending) {
          if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
          this.pending.delete(connection.deviceId);
          this.failure(pending.name, pending.callback, 10003, 'connection fail');
        }
      }
      this.emitConnection(connection.deviceId, connected);
    });
    connection.device.on('BLECharacteristicChange', (characteristic: ble.BLECharacteristic): void => {
      this.emitCharacteristic(connection.deviceId, characteristic);
    });
    connection.device.on('BLEMtuChange', (mtu: number): void => {
      connection.mtu = mtu;
      const result = new DMPMap();
      result.set('deviceId', connection.deviceId);
      result.set('mtu', mtu);
      this.emit(this.mtuListeners, result);
    });
  }

  private scanResult(scanResult: ble.ScanResult): DMPMap {
    const advertisement = this.parseAdvertisement(scanResult.data);
    const device = new DMPMap();
    device.set('deviceId', scanResult.deviceId);
    device.set('name', scanResult.deviceName ?? '');
    device.set('localName', scanResult.deviceName ?? '');
    device.set('RSSI', scanResult.rssi);
    device.set('advertisData', this.arrayBufferPayload(scanResult.data));
    device.set('advertisServiceUUIDs', advertisement.serviceUuids);
    device.set('serviceData', advertisement.serviceData.toJSON());
    return device;
  }

  private parseAdvertisement(buffer: ArrayBuffer): BluetoothAdvertisementData {
    const result = new BluetoothAdvertisementData();
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < bytes.length) {
      const length = bytes[offset];
      if (length === 0) break;
      const end = offset + length + 1;
      if (end > bytes.length || length < 1) break;
      const type = bytes[offset + 1];
      const start = offset + 2;
      const valueLength = length - 1;
      let uuidSize = 0;
      if (type === 0x02 || type === 0x03 || type === 0x16) uuidSize = 2;
      if (type === 0x04 || type === 0x05 || type === 0x20) uuidSize = 4;
      if (type === 0x06 || type === 0x07 || type === 0x21) uuidSize = 16;
      if (uuidSize > 0 && (type === 0x02 || type === 0x03 || type === 0x04 || type === 0x05 || type === 0x06 || type === 0x07)) {
        for (let index = start; index + uuidSize <= end; index += uuidSize) {
          result.serviceUuids.push(this.uuidFromLittleEndian(bytes, index, uuidSize));
        }
      } else if (uuidSize > 0 && valueLength >= uuidSize) {
        const uuid = this.uuidFromLittleEndian(bytes, start, uuidSize);
        const value = new ArrayBuffer(end - start - uuidSize);
        new Uint8Array(value).set(bytes.subarray(start + uuidSize, end));
        result.serviceData.set(uuid, this.arrayBufferPayload(value));
      }
      offset = end;
    }
    return result;
  }

  private uuidFromLittleEndian(bytes: Uint8Array, start: number, size: number): string {
    let value = '';
    for (let index = start + size - 1; index >= start; index--) {
      value += bytes[index].toString(16).padStart(2, '0');
    }
    return this.canonicalUuid(value);
  }

  private canonicalUuid(value: string): string {
    const clean = value.replace(/[{}-]/g, '').toUpperCase();
    if (clean.length === 4) return `0000${clean}-0000-1000-8000-00805F9B34FB`;
    if (clean.length === 8) return `${clean}-0000-1000-8000-00805F9B34FB`;
    if (clean.length === 32) {
      return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    }
    return value.toUpperCase();
  }

  private findService(connection: BluetoothGattConnection, data: DMPMap): ble.GattService | undefined {
    const serviceIdValue = data.getString('serviceId');
    const serviceId = serviceIdValue ? this.canonicalUuid(serviceIdValue) : undefined;
    if (!serviceId) return undefined;
    return connection.services.find((service: ble.GattService) => this.canonicalUuid(service.serviceUuid) === serviceId);
  }

  private findCharacteristic(
    connection: BluetoothGattConnection,
    data: DMPMap,
    name: string,
    callback: DMPBridgeCallback
  ): ble.BLECharacteristic | undefined {
    const service = this.findService(connection, data);
    if (!service) {
      this.failure(name, callback, 10004, 'no service');
      return undefined;
    }
    const characteristicIdValue = data.getString('characteristicId');
    const characteristicId = characteristicIdValue ? this.canonicalUuid(characteristicIdValue) : undefined;
    if (!characteristicId) {
      this.failure(name, callback, 10013, 'invalid_data');
      return undefined;
    }
    const characteristic = service.characteristics.find((item: ble.BLECharacteristic) =>
      this.canonicalUuid(item.characteristicUuid) === characteristicId
    );
    if (!characteristic) this.failure(name, callback, 10005, 'no characteristic');
    return characteristic;
  }

  private requireConnection(data: DMPMap, name: string, callback: DMPBridgeCallback): BluetoothGattConnection | undefined {
    if (!this.ensureInitialized(name, callback)) return undefined;
    const deviceId = this.requireString(data, 'deviceId', name, callback);
    if (!deviceId) return undefined;
    const connection = this.connections.get(deviceId);
    if (!connection) this.failure(name, callback, 10006, 'no connection');
    return connection;
  }

  private requireString(data: DMPMap, field: string, name: string, callback: DMPBridgeCallback): string | undefined {
    const value = data.getString(field)?.trim();
    if (!value) {
      this.failure(name, callback, 10013, 'invalid_data');
      return undefined;
    }
    return value;
  }

  private ensureInitialized(name: string, callback: DMPBridgeCallback): boolean {
    if (this.initialized) return true;
    this.failure(name, callback, 10000, 'not init');
    return false;
  }

  private ensureAvailable(name: string, callback: DMPBridgeCallback): boolean {
    if (!this.ensureInitialized(name, callback)) return false;
    if (this.isAvailable()) return true;
    this.failure(name, callback, 10001, 'not available');
    return false;
  }

  private isAvailable(): boolean {
    try {
      return this.isAvailableState(access.getState());
    } catch (_) {
      return false;
    }
  }

  private isAvailableState(state: access.BluetoothState): boolean {
    return state === access.BluetoothState.STATE_ON || state === access.BluetoothState.STATE_BLE_ON;
  }

  private stopScan(): void {
    if (!this.scanning) return;
    try { ble.stopBLEScan(); } catch (_) {}
    this.scanning = false;
  }

  private addListener(store: Map<string, DMPBridgeCallback>, data: DMPMap, callback: DMPBridgeCallback): void {
    const id = data.getString('callbackId') ?? data.getString('success');
    if (id) store.set(id, callback);
  }

  private removeListener(store: Map<string, DMPBridgeCallback>, data: DMPMap): void {
    const id = data.getString('callbackId');
    if (id) store.delete(id); else store.clear();
  }

  private emit(store: Map<string, DMPBridgeCallback>, result: DMPMap): void {
    store.forEach((callback: DMPBridgeCallback) => callback(result, DMPBridgeCallbackType.Success));
  }

  private emitConnection(deviceId: string, connected: boolean): void {
    const result = new DMPMap();
    result.set('deviceId', deviceId);
    result.set('connected', connected);
    this.emit(this.connectionListeners, result);
  }

  private emitCharacteristic(deviceId: string, characteristic: ble.BLECharacteristic): void {
    const result = new DMPMap();
    result.set('deviceId', deviceId);
    result.set('serviceId', characteristic.serviceUuid.toUpperCase());
    result.set('characteristicId', characteristic.characteristicUuid.toUpperCase());
    result.set('value', this.arrayBufferPayload(characteristic.characteristicValue));
    this.emit(this.characteristicListeners, result);
  }

  private success(name: string, callback: DMPBridgeCallback, value?: DMPMap): void {
    const result = value ?? new DMPMap();
    result.set('errMsg', `${name}:ok`);
    callback(result, DMPBridgeCallbackType.Success);
    callback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }

  private failure(name: string, callback: DMPBridgeCallback, code: number, message: string): void {
    const result = new DMPMap();
    result.set('errCode', code);
    result.set('errMsg', `${name}:fail ${message}`);
    callback(result, DMPBridgeCallbackType.Fail);
    callback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }

  private errorCode(error: object): number {
    const businessError = error as BusinessError;
    if (businessError.code === 2900003) return 10001;
    if (businessError.code === 2901003) return 10006;
    if (businessError.code === 401) return 10013;
    if (businessError.code === 801) return 10009;
    return 10008;
  }

  private errorMessage(error: object): string {
    return (error as BusinessError).message ?? 'system error';
  }

  private arrayBufferPayload(buffer: ArrayBuffer): object {
    const result = new DMPMap();
    result.set(ARRAY_BUFFER_BASE64_KEY, this.arrayBufferToBase64(buffer));
    return result.toJSON();
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let result = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      result += BASE64_CHARS.charAt(bytes[i] >> 2);
      result += BASE64_CHARS.charAt(((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4));
      result += BASE64_CHARS.charAt(((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6));
      result += BASE64_CHARS.charAt(bytes[i + 2] & 63);
    }
    if (i < bytes.length) {
      result += BASE64_CHARS.charAt(bytes[i] >> 2);
      if (i + 1 < bytes.length) {
        result += BASE64_CHARS.charAt(((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4));
        result += BASE64_CHARS.charAt((bytes[i + 1] & 15) << 2) + '=';
      } else {
        result += BASE64_CHARS.charAt((bytes[i] & 3) << 4) + '==';
      }
    }
    return result;
  }

  private decodeArrayBuffer(value: object): ArrayBuffer | undefined {
    const encoded = DMPMap.createFromObject(value);
    const base64 = encoded.getString(ARRAY_BUFFER_BASE64_KEY);
    if (base64 === undefined) return undefined;
    const clean = base64.replace(/[\r\n\s]/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const length = clean.length * 3 / 4 - padding;
    const buffer = new ArrayBuffer(length);
    const bytes = new Uint8Array(buffer);
    let index = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const c1 = BASE64_CHARS.indexOf(clean[i]);
      const c2 = BASE64_CHARS.indexOf(clean[i + 1]);
      const c3 = clean[i + 2] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 2]);
      const c4 = clean[i + 3] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 3]);
      if (index < length) bytes[index++] = (c1 << 2) | (c2 >> 4);
      if (index < length) bytes[index++] = ((c2 & 15) << 4) | (c3 >> 2);
      if (index < length) bytes[index++] = ((c3 & 3) << 6) | c4;
    }
    return buffer;
  }

  dispose(): void {
    this.stopScan();
    if (this.scanSubscribed) {
      try { ble.off('BLEDeviceFind', this.scanCallback); } catch (_) {}
      this.scanSubscribed = false;
    }
    if (this.stateSubscribed) {
      try { access.off('stateChange', this.stateChangeCallback); } catch (_) {}
      this.stateSubscribed = false;
    }
    this.connections.forEach((connection: BluetoothGattConnection) => {
      try { connection.device.disconnect(); connection.device.close(); } catch (_) {}
    });
    this.connections.clear();
    this.pending.forEach((pending: BluetoothPendingCall) => {
      if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
    });
    this.pending.clear();
    this.foundDevices.clear();
    this.adapterListeners.clear();
    this.deviceListeners.clear();
    this.connectionListeners.clear();
    this.characteristicListeners.clear();
    this.mtuListeners.clear();
  }
}
