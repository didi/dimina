import { mdns, socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DMPContainerBridgesModule } from '../DMPContainerBridgesModule';
import { DMPBridgeCallback, DMPBridgeCallbackType } from '../DMPTSUtil';
import { DMPMap } from '../../Utils/DMPMap';
import { DMPContextUtils } from '../../Utils/DMPContextUtils';

const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

class HarmonyUdpState {
  id: string;
  instance: socket.MulticastSocket;
  port: number = 0;
  bound: boolean = false;
  closeEmitted: boolean = false;
  binding?: Promise<void>;

  constructor(id: string, instance: socket.MulticastSocket) {
    this.id = id;
    this.instance = instance;
  }
}

class HarmonyTcpState {
  id: string;
  instance: socket.TCPSocket;
  closeEmitted: boolean = false;

  constructor(id: string, instance: socket.TCPSocket) {
    this.id = id;
    this.instance = instance;
  }
}

/** WeChat-compatible mDNS, UDP socket, and TCP client bridge for HarmonyOS. */
export class DMPContainerBridgesModuleLocalNetwork extends DMPContainerBridgesModule {
  private udpSockets: Map<string, HarmonyUdpState> = new Map();
  private tcpSockets: Map<string, HarmonyTcpState> = new Map();
  private listeners: Map<string, DMPBridgeCallback> = new Map();
  private discovery?: mdns.DiscoveryService;
  private discoveryType: string = '';
  private startCallback?: DMPBridgeCallback;
  private stopCallback?: DMPBridgeCallback;

  getExportMethods(): string[] {
    return [
      'startLocalServiceDiscovery', 'stopLocalServiceDiscovery',
      'onLocalServiceDiscoveryStop', 'offLocalServiceDiscoveryStop',
      'onLocalServiceFound', 'offLocalServiceFound',
      'onLocalServiceLost', 'offLocalServiceLost',
      'onLocalServiceResolveFail', 'offLocalServiceResolveFail',
      'UDPSocket.bind', 'UDPSocket.close', 'UDPSocket.connect', 'UDPSocket.send',
      'UDPSocket.write', 'UDPSocket.setTTL',
      'UDPSocket.onClose', 'UDPSocket.offClose', 'UDPSocket.onError', 'UDPSocket.offError',
      'UDPSocket.onListening', 'UDPSocket.offListening', 'UDPSocket.onMessage', 'UDPSocket.offMessage',
      'TCPSocket.close', 'TCPSocket.connect', 'TCPSocket.write',
      'TCPSocket.onClose', 'TCPSocket.offClose',
      'TCPSocket.onConnect', 'TCPSocket.offConnect', 'TCPSocket.onError', 'TCPSocket.offError',
      'TCPSocket.onMessage', 'TCPSocket.offMessage'
    ];
  }

  dispatchLocalNetwork(methodName: string, params: DMPMap | number | string | boolean | object,
    callback: DMPBridgeCallback): DMPMap | number | string | boolean | object {
    const data = params instanceof DMPMap ? params : DMPMap.createFromObject(params as Object);
    try {
      switch (methodName) {
        case 'startLocalServiceDiscovery': this.startDiscovery(data, callback); break;
        case 'stopLocalServiceDiscovery': this.stopDiscovery(callback); break;
        case 'onLocalServiceDiscoveryStop': case 'onLocalServiceFound': case 'onLocalServiceLost':
        case 'onLocalServiceResolveFail': case 'UDPSocket.onClose': case 'UDPSocket.onError':
        case 'UDPSocket.onListening': case 'UDPSocket.onMessage': case 'TCPSocket.onBindWifi':
        case 'TCPSocket.onClose': case 'TCPSocket.onConnect': case 'TCPSocket.onError': case 'TCPSocket.onMessage':
          this.addListener(methodName, data, callback); break;
        case 'offLocalServiceDiscoveryStop': case 'offLocalServiceFound': case 'offLocalServiceLost':
        case 'offLocalServiceResolveFail': case 'UDPSocket.offClose': case 'UDPSocket.offError':
        case 'UDPSocket.offListening': case 'UDPSocket.offMessage': case 'TCPSocket.offBindWifi':
        case 'TCPSocket.offClose': case 'TCPSocket.offConnect': case 'TCPSocket.offError': case 'TCPSocket.offMessage':
          this.removeListener(methodName, data); break;
        case 'UDPSocket.bind': return this.bindUdp(data);
        case 'UDPSocket.close': this.closeUdp(data); break;
        case 'UDPSocket.connect': this.connectUdp(data); break;
        case 'UDPSocket.send': case 'UDPSocket.write': this.sendUdp(data); break;
        case 'UDPSocket.setTTL': this.setUdpTtl(data); break;
        case 'TCPSocket.bindWifi': this.emitError('TCPSocket.onError', this.socketId(data), 'system not support'); break;
        case 'TCPSocket.close': this.closeTcp(data); break;
        case 'TCPSocket.connect': this.connectTcp(data); break;
        case 'TCPSocket.write': this.writeTcp(data); break;
      }
    } catch (error) {
      if (methodName === 'UDPSocket.bind') throw new Error(this.errorMessage(error));
      if (methodName.startsWith('UDPSocket.')) {
        this.emitError('UDPSocket.onError', data.getString('socketId') ?? '', this.errorMessage(error));
      } else if (methodName.startsWith('TCPSocket.')) {
        this.emitError('TCPSocket.onError', data.getString('socketId') ?? '', this.errorMessage(error));
      }
    }
    return new DMPMap();
  }

  private startDiscovery(data: DMPMap, callback: DMPBridgeCallback): void {
    const serviceType = (data.getString('serviceType') ?? '').trim();
    if (!serviceType) {
      this.failure('startLocalServiceDiscovery', callback, 'invalid param');
      return;
    }
    if (this.discovery) {
      this.failure('startLocalServiceDiscovery', callback, 'scan task already exist');
      return;
    }
    try {
      const discovery = mdns.createDiscoveryService(DMPContextUtils.getUIAbilityContext(), serviceType);
      this.discovery = discovery;
      this.discoveryType = serviceType;
      this.startCallback = callback;
      discovery.on('discoveryStart', (event: mdns.DiscoveryEventInfo): void => {
        if (event.errorCode !== undefined) {
          const failedCallback = this.startCallback;
          this.releaseDiscovery();
          this.failure('startLocalServiceDiscovery', failedCallback, `error ${event.errorCode}`);
          return;
        }
        this.success('startLocalServiceDiscovery', this.startCallback);
        this.startCallback = undefined;
      });
      discovery.on('discoveryStop', (_event: mdns.DiscoveryEventInfo): void => {
        this.emit('onLocalServiceDiscoveryStop', '', new DMPMap());
        this.success('stopLocalServiceDiscovery', this.stopCallback);
        this.stopCallback = undefined;
        this.releaseDiscovery();
      });
      discovery.on('serviceFound', (service: mdns.LocalServiceInfo): void => this.resolveService(service));
      discovery.on('serviceLost', (service: mdns.LocalServiceInfo): void => {
        this.emit('onLocalServiceLost', '', this.serviceResult(service));
      });
      discovery.startSearchingMDNS();
    } catch (error) {
      this.releaseDiscovery();
      this.failure('startLocalServiceDiscovery', callback, this.errorMessage(error));
    }
  }

  private stopDiscovery(callback: DMPBridgeCallback): void {
    if (!this.discovery) {
      this.success('stopLocalServiceDiscovery', callback);
      return;
    }
    this.stopCallback = callback;
    try {
      this.discovery.stopSearchingMDNS();
    } catch (error) {
      this.stopCallback = undefined;
      this.failure('stopLocalServiceDiscovery', callback, this.errorMessage(error));
    }
  }

  private resolveService(service: mdns.LocalServiceInfo): void {
    mdns.resolveLocalService(DMPContextUtils.getUIAbilityContext(), service)
      .then((resolved: mdns.LocalServiceInfo): void => {
        const result = this.serviceResult(resolved);
        result.set('ip', resolved.host?.address ?? '');
        result.set('port', resolved.port ?? 0);
        this.emit('onLocalServiceFound', '', result);
      })
      .catch((_error: BusinessError): void => {
        this.emit('onLocalServiceResolveFail', '', this.serviceResult(service));
      });
  }

  private releaseDiscovery(): void {
    if (this.discovery) {
      try { this.discovery.off('discoveryStart'); } catch (_) {}
      try { this.discovery.off('discoveryStop'); } catch (_) {}
      try { this.discovery.off('serviceFound'); } catch (_) {}
      try { this.discovery.off('serviceLost'); } catch (_) {}
    }
    this.discovery = undefined;
    this.discoveryType = '';
    this.startCallback = undefined;
  }

  private bindUdp(data: DMPMap): number {
    const id = this.socketId(data);
    const requested = data.getNumber('port') ?? 0;
    if (requested < 0 || requested > 65535) throw new Error('invalid port');
    const state = this.udpState(id);
    if (state.bound || state.port > 0) return state.port;

    // Harmony's socket API binds asynchronously. Reserve a high ephemeral port so the
    // WeChat-compatible bridge can still return the selected port synchronously.
    const port = requested === 0 ? 49152 + Math.floor(Math.random() * 16384) : requested;
    state.port = port;
    state.binding = state.instance.bind({ address: '::', family: 2, port: port })
      .then((): void => { state.bound = true; });
    state.binding.catch((error: BusinessError): void => {
      state.port = 0;
      state.binding = undefined;
      this.emitError('UDPSocket.onError', id, error.message);
    });
    return port;
  }

  private connectUdp(data: DMPMap): void {
    const id = this.socketId(data);
    this.requiredAddress(data);
    this.requiredPort(data);
    this.ensureUdpBound(this.udpState(id));
  }

  private sendUdp(data: DMPMap): void {
    const id = this.socketId(data);
    const state = this.udpState(id);
    const address = this.requiredAddress(data);
    const port = this.requiredPort(data);
    let message = this.message(data.get('message'));
    if (message instanceof ArrayBuffer) {
      const offset = Math.max(data.getNumber('offset') ?? 0, 0);
      const length = Math.min(data.getNumber('length') ?? message.byteLength - offset, message.byteLength - offset);
      if (offset > message.byteLength || length < 0) throw new Error('invalid offset or length');
      message = message.slice(offset, offset + length);
    }
    const send = (): void => {
      const sendMessage = (): void => {
        state.instance.send({ data: message, address: { address: address, port: port } })
          .catch((error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
      };
      if (data.getBoolean('setBroadcast') !== true) {
        sendMessage();
        return;
      }
      state.instance.setExtraOptions({ broadcast: true })
        .then((): void => sendMessage())
        .catch((error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
    };
    this.ensureUdpBound(state, send);
  }

  private setUdpTtl(data: DMPMap): void {
    const id = this.socketId(data);
    const ttl = data.getNumber('ttl') ?? -1;
    if (ttl < 0 || ttl > 255) throw new Error('ttl must be between 0 and 255');
    this.udpState(id).instance.setMulticastTTL(ttl)
      .catch((error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
  }

  private closeUdp(data: DMPMap): void {
    const id = this.socketId(data);
    const state = this.udpSockets.get(id);
    if (!state) return;
    state.instance.close()
      .then((): void => {
        if (!state.closeEmitted) {
          state.closeEmitted = true;
          this.emit('UDPSocket.onClose', id, new DMPMap());
        }
        this.udpSockets.delete(id);
        this.clearSocketListeners('UDPSocket', id);
      })
      .catch((error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
  }

  private ensureUdpBound(state: HarmonyUdpState, continuation?: () => void): void {
    if (state.bound) {
      continuation?.();
      return;
    }
    if (state.binding) {
      state.binding.then((): void => { continuation?.(); });
      return;
    }
    const port = 49152 + Math.floor(Math.random() * 16384);
    state.port = port;
    state.binding = state.instance.bind({ address: '::', family: 2, port: port })
      .then((): void => { state.bound = true; continuation?.(); });
    state.binding.catch((error: BusinessError): void => {
      state.port = 0;
      state.binding = undefined;
      this.emitError('UDPSocket.onError', state.id, error.message);
    });
  }

  private udpState(id: string): HarmonyUdpState {
    const existing = this.udpSockets.get(id);
    if (existing) return existing;
    const state = new HarmonyUdpState(id, socket.constructMulticastSocketInstance());
    state.instance.on('listening', (): void => {
      state.bound = true;
      this.emit('UDPSocket.onListening', id, new DMPMap());
    });
    state.instance.on('close', (): void => {
      if (state.closeEmitted) return;
      state.closeEmitted = true;
      this.emit('UDPSocket.onClose', id, new DMPMap());
      this.udpSockets.delete(id);
      this.clearSocketListeners('UDPSocket', id);
    });
    state.instance.on('error', (error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
    state.instance.on('message', (info: socket.SocketMessageInfo): void => {
      state.instance.getLocalAddress().then((local: socket.NetAddress): void => {
        const result = new DMPMap();
        result.set('message', this.arrayBufferPayload(info.message));
        result.set('remoteInfo', this.remoteInfo(info.remoteInfo, true));
        result.set('localInfo', this.netAddressInfo(local));
        this.emit('UDPSocket.onMessage', id, result);
      }).catch((error: BusinessError): void => this.emitError('UDPSocket.onError', id, error.message));
    });
    this.udpSockets.set(id, state);
    return state;
  }

  private connectTcp(data: DMPMap): void {
    const id = this.socketId(data);
    const state = this.tcpState(id);
    const address = this.requiredAddress(data);
    const port = this.requiredPort(data);
    const timeout = Math.max(data.getNumber('timeout') ?? 2, 0) * 1000;
    state.instance.connect({ address: { address: address, port: port }, timeout: timeout })
      .catch((error: BusinessError): void => this.emitError('TCPSocket.onError', id, error.message));
  }

  private writeTcp(data: DMPMap): void {
    const id = this.socketId(data);
    this.tcpState(id).instance.send({ data: this.message(data.get('data')) })
      .catch((error: BusinessError): void => this.emitError('TCPSocket.onError', id, error.message));
  }

  private closeTcp(data: DMPMap): void {
    const id = this.socketId(data);
    const state = this.tcpSockets.get(id);
    if (!state) return;
    state.instance.close()
      .then((): void => {
        if (!state.closeEmitted) {
          state.closeEmitted = true;
          this.emit('TCPSocket.onClose', id, new DMPMap());
        }
        this.tcpSockets.delete(id);
        this.clearSocketListeners('TCPSocket', id);
      })
      .catch((error: BusinessError): void => this.emitError('TCPSocket.onError', id, error.message));
  }

  private tcpState(id: string): HarmonyTcpState {
    const existing = this.tcpSockets.get(id);
    if (existing) return existing;
    const state = new HarmonyTcpState(id, socket.constructTCPSocketInstance());
    state.instance.on('connect', (): void => this.emit('TCPSocket.onConnect', id, new DMPMap()));
    state.instance.on('close', (): void => {
      if (state.closeEmitted) return;
      state.closeEmitted = true;
      this.emit('TCPSocket.onClose', id, new DMPMap());
      this.tcpSockets.delete(id);
      this.clearSocketListeners('TCPSocket', id);
    });
    state.instance.on('error', (error: BusinessError): void => this.emitError('TCPSocket.onError', id, error.message));
    state.instance.on('message', (info: socket.SocketMessageInfo): void => {
      state.instance.getLocalAddress().then((local: socket.NetAddress): void => {
        const result = new DMPMap();
        result.set('message', this.arrayBufferPayload(info.message));
        result.set('remoteInfo', this.remoteInfo(info.remoteInfo, false));
        result.set('localInfo', this.netAddressInfo(local));
        this.emit('TCPSocket.onMessage', id, result);
      }).catch((error: BusinessError): void => this.emitError('TCPSocket.onError', id, error.message));
    });
    this.tcpSockets.set(id, state);
    return state;
  }

  private addListener(event: string, data: DMPMap, callback: DMPBridgeCallback): void {
    if (!callback) return;
    this.listeners.set(this.eventKey(event, data.getString('socketId') ?? ''), callback);
  }

  private removeListener(offEvent: string, data: DMPMap): void {
    const event = offEvent.startsWith('off') ? `on${offEvent.substring(3)}` : offEvent.replace('.off', '.on');
    this.listeners.delete(this.eventKey(event, data.getString('socketId') ?? ''));
  }

  private emit(event: string, socketId: string, value: DMPMap): void {
    this.listeners.get(this.eventKey(event, socketId))?.(value, DMPBridgeCallbackType.Success);
  }

  private emitError(event: string, socketId: string, message: string): void {
    const result = new DMPMap();
    result.set('errMsg', message);
    this.emit(event, socketId, result);
  }

  private success(name: string, callback?: DMPBridgeCallback): void {
    if (!callback) return;
    const result = new DMPMap();
    result.set('errMsg', `${name}:ok`);
    callback(result, DMPBridgeCallbackType.Success);
    callback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }

  private failure(name: string, callback: DMPBridgeCallback | undefined, message: string): void {
    if (!callback) return;
    const result = new DMPMap();
    result.set('errMsg', `${name}:fail ${message}`);
    callback(result, DMPBridgeCallbackType.Fail);
    callback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }

  private serviceResult(service: mdns.LocalServiceInfo): DMPMap {
    const result = new DMPMap();
    result.set('serviceType', service.serviceType || this.discoveryType);
    result.set('serviceName', service.serviceName);
    return result;
  }

  private remoteInfo(info: socket.SocketRemoteInfo, includeSize: boolean): object {
    const result = new DMPMap();
    result.set('address', info.address);
    result.set('family', info.family);
    result.set('port', info.port);
    if (includeSize) result.set('size', info.size);
    return result.toJSON();
  }

  private netAddressInfo(info: socket.NetAddress): object {
    const result = new DMPMap();
    result.set('address', info.address);
    result.set('family', info.family === 2 ? 'IPv6' : 'IPv4');
    result.set('port', info.port ?? 0);
    return result.toJSON();
  }

  private socketId(data: DMPMap): string {
    const id = data.getString('socketId') ?? '';
    if (!id) throw new Error('socketId is required');
    return id;
  }

  private requiredAddress(data: DMPMap): string {
    const address = data.getString('address') ?? '';
    if (!address) throw new Error('address is required');
    return address;
  }

  private requiredPort(data: DMPMap): number {
    const port = data.getNumber('port') ?? -1;
    if (port < 0 || port > 65535) throw new Error('invalid port');
    return port;
  }

  private message(value: Object | string | number | boolean | undefined): string | ArrayBuffer {
    if (typeof value === 'string') return value;
    if (value instanceof Object) {
      const decoded = this.decodeArrayBuffer(value);
      if (decoded) return decoded;
    }
    throw new Error('message must be a string or ArrayBuffer');
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
    const base64 = DMPMap.createFromObject(value).getString(ARRAY_BUFFER_BASE64_KEY);
    if (base64 === undefined) return undefined;
    const clean = base64.replace(/[\r\n\s]/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const length = clean.length * 3 / 4 - padding;
    const buffer = new ArrayBuffer(length);
    const bytes = new Uint8Array(buffer);
    let index = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const first = BASE64_CHARS.indexOf(clean[i]);
      const second = BASE64_CHARS.indexOf(clean[i + 1]);
      const third = clean[i + 2] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 2]);
      const fourth = clean[i + 3] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 3]);
      if (index < length) bytes[index++] = (first << 2) | (second >> 4);
      if (index < length) bytes[index++] = ((second & 15) << 4) | (third >> 2);
      if (index < length) bytes[index++] = ((third & 3) << 6) | fourth;
    }
    return buffer;
  }

  private eventKey(event: string, socketId: string): string { return `${event}\u0000${socketId}`; }

  private clearSocketListeners(prefix: string, socketId: string): void {
    Array.from(this.listeners.keys())
      .filter((key: string): boolean => key.startsWith(`${prefix}.`) && key.endsWith(`\u0000${socketId}`))
      .forEach((key: string): void => { this.listeners.delete(key); });
  }

  private errorMessage(error: Object | string | number | boolean | undefined): string {
    return (error as BusinessError)?.message ?? String(error ?? 'operation failed');
  }

  dispose(): void {
    try { this.discovery?.stopSearchingMDNS(); } catch (_) {}
    this.releaseDiscovery();
    this.udpSockets.forEach((state: HarmonyUdpState): void => { state.instance.close().catch((): void => {}); });
    this.tcpSockets.forEach((state: HarmonyTcpState): void => { state.instance.close().catch((): void => {}); });
    this.udpSockets.clear();
    this.tcpSockets.clear();
    this.listeners.clear();
  }
}
