/**
 * 原生 WebSocket（wx.connectSocket / SocketTask）鸿蒙实现。
 *
 * 内容包括：owners/sockets/legacy 等数据模型与 disposeOwner 清理；connectSocket/
 * closeSocket 的校验顺序与错误串；事件互斥与顺序（open 才能 close，error/close 至多
 * 各触发一次）及 close 竞态处理（CREATED 期取消 / CONNECTING 期撕毁 / CLOSING 期重复
 * close）；后台/前台切换的宽限期策略；遗留全局 API（单槽 + 首活绑定）；空闲超时；
 * 以及二进制帧的线上格式（base64 + isBuffer）。
 *
 * 传输层与定时器均通过可注入的工厂/调度器抽象（见文件尾部），供 hypium 单测使用
 * 脚本化 fake 传输与可控时钟，无需真实网络即可覆盖竞态用例。
 */
import { webSocket } from '@kit.NetworkKit';
import { AsyncCallback, BusinessError, Callback, ErrorCallback } from '@kit.BasicServicesKit';
import { DMPMap } from '../../Utils/DMPMap';
import { DMPBridgeCallback, DMPBridgeCallbackType } from '../DMPTSUtil';

// 注意：本文件是 .ts（不是 .ets），因此不能直接 import 任何 .ets 文件
// （ArkTS 工程规则："Importing ArkTS files in JS and TS files is forbidden"）。
// DMPChannelProxyNext（事件推送）与 DMPLogger（日志）都是 .ets，改由
// DMPContainerBridgesModule+WebSocket.ets 在构造时通过 setProductionEmitter /
// setProductionLogger 注入，Manager 自身保持零 .ets 依赖、可在 hypium 中直接单测。
//
// URL 解析 / UTF-8 字节计数 / base64 编解码均改为纯 JS 手写实现，不依赖
// @ohos.url / @ohos.util：hypium 本地单测的 PC 侧模拟运行时缺少 URLSearchParams
// 全局对象，会导致 url.URL.parseURL 抛 "ReferenceError: URLSearchParams is not
// defined"（真机上可用，但本地单测环境不提供）；手写实现三端环境一致可测，且
// DMPContainerBridgesModule+File.ets 里 base64 手写已是本仓库既有先例。

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 0x7fffffff;
const MAX_CONNECTIONS_PER_OWNER = 5;
const DEFAULT_BACKGROUND_GRACE_MS = 5000;
const DEFAULT_CLOSE_CODE = 1000;
const MAX_REASON_UTF8_BYTES = 123;

const DISALLOWED_HEADER_NAMES: Set<string> = new Set<string>([
  'connection', 'content-length', 'host', 'referer',
  'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-key',
  'sec-websocket-protocol', 'sec-websocket-version', 'upgrade',
]);

/** ------------------------------------------------------------------ */
/** 纯 JS 工具（URL 解析 / UTF-8 字节计数 / base64），零 SDK 依赖，见文件头注释 */
/** ------------------------------------------------------------------ */

class ParsedWsUrl {
  ok: boolean = false;
  scheme: string = '';
  host: string = '';
  hash: string = '';
}

/** 解析 `scheme://[userinfo@]host[:port][/path][?query][#fragment]` 形式的绝对 URL。
 *  只关心 wx.connectSocket 校验所需的三个字段：scheme（含冒号）、host（含端口，不含
 *  userinfo/凭据）、hash（含 # 号，无则为空串）。*/
function parseWsUrl(raw: string): ParsedWsUrl {
  const result = new ParsedWsUrl();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([^#]*)(#.*)?$/.exec(raw);
  if (!match) {
    return result;
  }
  const authority = match[2];
  // authority = [userinfo@]host[:port]。Origin 头只应含 host[:port]，不应包含
  // userinfo/凭据，这里先剥离；剥离后的 host[:port] 再做字符集校验，拒绝
  // "ws://bad host"（含空格）这类不合法字符串，而不是放到真机 SDK 深处才报错。
  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  if (!isValidHostPort(hostPort)) {
    return result;
  }
  result.ok = true;
  result.scheme = `${match[1].toLowerCase()}:`;
  result.host = hostPort;
  result.hash = match[4] ?? '';
  return result;
}

/** 校验 host[:port]：IPv6 字面量（[...]，可带 :port）或常规 reg-name/IPv4（字母数字/./-，可带 :port）。 */
function isValidHostPort(hostPort: string): boolean {
  if (hostPort.length === 0) {
    return false;
  }
  if (hostPort.charAt(0) === '[') {
    return /^\[[0-9a-fA-F:]+\](:[0-9]+)?$/.test(hostPort);
  }
  return /^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(hostPort);
}

/** 若 host[:port] 里的端口就是该 scheme 的默认端口（ws->80, wss->443），剥掉端口
 *  只留 host，对齐 Android `URI`-based 与 dimina-kit `new URL(...).origin` 的 Origin
 *  计算规则——只用于 Origin 头，不影响实际拨号用的原始 URL。 */
function stripDefaultPort(hostPort: string, scheme: string): string {
  const defaultPort = scheme === 'wss:' ? '443' : '80';
  const isBracket = hostPort.charAt(0) === '[';
  const pattern = isBracket ? /^(\[[0-9a-fA-F:]+\]):([0-9]+)$/ : /^([A-Za-z0-9.-]+):([0-9]+)$/;
  const match = pattern.exec(hostPort);
  if (match && match[2] === defaultPort) {
    return match[1];
  }
  return hostPort;
}

/** 计算字符串的 UTF-8 字节长度（JS 字符串本身是 UTF-16，逐码元换算，正确处理代理对）。 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // 代理对 -> 一个 U+10000~U+10FFFF 码点，UTF-8 编码为 4 字节
        i++;
        continue;
      }
    }
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 标准 base64 编码（无换行），实现风格与 DMPContainerBridgesModule+File.ets 的手写版一致。 */
function base64Encode(bytes: Uint8Array): string {
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
      result += BASE64_CHARS.charAt((bytes[i + 1] & 15) << 2);
      result += '=';
    } else {
      result += BASE64_CHARS.charAt((bytes[i] & 3) << 4);
      result += '==';
    }
  }
  return result;
}

/** 标准 base64 解码，不容忍任何空白/换行（对齐 Android Base64.getDecoder() / iOS
 *  Data(base64Encoded:) 的严格度——两者都会拒绝带空白的输入，不像早期手写版先剥除
 *  空白再解码）；非法输入（长度非 4 的倍数、字符集之外的字符、'=' 出现在末尾以外的
 *  位置）一律抛错，交由调用方转成 sendSocketMessage:fail（而不是把非法字符静默按 0
 *  处理、发出被污染的字节还报 ok）。 */
function base64Decode(base64: string): Uint8Array {
  const clean = base64 ?? '';
  if (clean.length === 0) {
    return new Uint8Array(0);
  }
  if (clean.length % 4 !== 0) {
    throw new Error('invalid base64 length');
  }
  const paddingMatch = /=*$/.exec(clean);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  if (padding > 2) {
    throw new Error('invalid base64 padding');
  }
  const bodyLength = clean.length - padding;
  for (let i = 0; i < bodyLength; i++) {
    if (BASE64_CHARS.indexOf(clean[i]) === -1) {
      throw new Error('invalid base64 character');
    }
  }
  const length = Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
  const buffer = new Uint8Array(length);
  let index = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = BASE64_CHARS.indexOf(clean[i]);
    const c2 = i + 1 < clean.length ? BASE64_CHARS.indexOf(clean[i + 1]) : 0;
    const c3 = i + 2 < clean.length && clean[i + 2] !== '=' ? BASE64_CHARS.indexOf(clean[i + 2]) : 0;
    const c4 = i + 3 < clean.length && clean[i + 3] !== '=' ? BASE64_CHARS.indexOf(clean[i + 3]) : 0;
    if (index < length) {
      buffer[index++] = ((c1 & 63) << 2) | ((c2 & 48) >> 4);
    }
    if (index < length) {
      buffer[index++] = ((c2 & 15) << 4) | ((c3 & 60) >> 2);
    }
    if (index < length) {
      buffer[index++] = ((c3 & 3) << 6) | (c4 & 63);
    }
  }
  return buffer;
}

export enum DMPSocketState {
  CREATED,
  CONNECTING,
  OPEN,
  CLOSING,
}

/** ------------------------------------------------------------------ */
/** 传输层抽象（可测性核心：生产走 @ohos.net.webSocket，单测注入 fake） */
/** ------------------------------------------------------------------ */

export interface DMPSocketTransport {
  connect(url: string, options: webSocket.WebSocketRequestOptions, callback: AsyncCallback<boolean>): void;

  send(data: string | ArrayBuffer, callback: AsyncCallback<boolean>): void;

  close(options: webSocket.WebSocketCloseOptions, callback: AsyncCallback<boolean>): void;

  on(type: 'open', callback: AsyncCallback<Object>): void;

  on(type: 'message', callback: AsyncCallback<string | ArrayBuffer>): void;

  on(type: 'close', callback: AsyncCallback<webSocket.CloseResult>): void;

  on(type: 'error', callback: ErrorCallback): void;

  on(type: 'headerReceive', callback: Callback<webSocket.ResponseHeaders>): void;

  off(type: 'open'): void;

  off(type: 'message'): void;

  off(type: 'close'): void;

  off(type: 'error'): void;

  off(type: 'headerReceive'): void;
}

export type DMPSocketTransportFactory = () => DMPSocketTransport;

function defaultTransportFactory(): DMPSocketTransport {
  return webSocket.createWebSocket();
}

/** ------------------------------------------------------------------ */
/** 定时器抽象（可测性：单测注入可手动推进的假时钟） */
/** ------------------------------------------------------------------ */

export interface DMPTimerScheduler {
  schedule(fn: () => void, delayMs: number): number;

  cancel(handle: number): void;

  now(): number;
}

class DMPRealTimerScheduler implements DMPTimerScheduler {
  schedule(fn: () => void, delayMs: number): number {
    return setTimeout(fn, delayMs) as number;
  }

  cancel(handle: number): void {
    if (handle >= 0) {
      clearTimeout(handle);
    }
  }

  now(): number {
    return Date.now();
  }
}

/** ------------------------------------------------------------------ */
/** 校验（namespace 导出纯函数，供 hypium 直接单测，镜像 normalize.ts） */
/** ------------------------------------------------------------------ */

export namespace DMPWebSocketValidation {
  export class UrlValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    rawUrl: string = '';
    scheme: string = '';
    host: string = '';
  }

  export class TimeoutValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    value: number = DEFAULT_TIMEOUT_MS;
  }

  export class ProtocolsValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    value: string[] = [];
  }

  export class HeaderValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    value: Map<string, string> = new Map<string, string>();
  }

  export class CloseCodeValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    value: number = DEFAULT_CLOSE_CODE;
  }

  export class CloseReasonValidationResult {
    ok: boolean = false;
    errMsg: string = '';
    value: string = '';
  }

  export function validateUrl(raw: Object | undefined | null): UrlValidationResult {
    const result = new UrlValidationResult();
    if (typeof raw !== 'string' || raw.length === 0) {
      result.errMsg = 'invalid url';
      return result;
    }
    const parsed = parseWsUrl(raw);
    if (!parsed.ok) {
      result.errMsg = 'invalid url';
      return result;
    }
    if (parsed.scheme !== 'ws:' && parsed.scheme !== 'wss:') {
      result.errMsg = 'invalid url';
      return result;
    }
    if (parsed.hash.length > 0) {
      result.errMsg = 'invalid url';
      return result;
    }
    result.ok = true;
    result.rawUrl = raw;
    result.scheme = parsed.scheme;
    result.host = parsed.host;
    return result;
  }

  export function validateTimeout(raw: Object | undefined | null): TimeoutValidationResult {
    const result = new TimeoutValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      result.value = DEFAULT_TIMEOUT_MS;
      return result;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num > MAX_TIMEOUT_MS) {
      result.errMsg = 'invalid timeout';
      return result;
    }
    if (num <= 0) {
      result.ok = true;
      result.value = DEFAULT_TIMEOUT_MS;
      return result;
    }
    result.ok = true;
    result.value = Math.trunc(num);
    return result;
  }

  export function validateProtocols(raw: Object | undefined | null): ProtocolsValidationResult {
    const result = new ProtocolsValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      return result;
    }
    if (!Array.isArray(raw)) {
      result.errMsg = 'protocols must be an array';
      return result;
    }
    const arr = raw as Array<Object>;
    const list: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item !== 'string' || item.length === 0) {
        result.errMsg = 'invalid protocol';
        return result;
      }
      list.push(item);
    }
    result.ok = true;
    result.value = list;
    return result;
  }

  export function validateHeader(raw: Object | undefined | null): HeaderValidationResult {
    const result = new HeaderValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      return result;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      result.errMsg = 'header must be an object';
      return result;
    }
    const record = raw as { [key: string]: Object };
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i++) {
      const rawName = keys[i];
      const rawValue = record[rawName];
      // Check the RAW (untrimmed) name for CR/LF FIRST, before any trim/empty/forbidden/null
      // early-continue below — matching Android/iOS. Checking after those early-continues let a
      // name like "\r\n" (trims to empty), "Host\r\n" (trims to a forbidden name), or a CR/LF name
      // paired with a null value silently fall through as "dropped" instead of failing
      // `invalid header`.
      if (/[\r\n]/.test(rawName)) {
        result.errMsg = 'invalid header';
        return result;
      }
      const name = rawName.trim();
      if (name.length === 0) {
        continue; // 静默丢弃
      }
      if (DISALLOWED_HEADER_NAMES.has(name.toLowerCase())) {
        continue; // 静默丢弃
      }
      if (rawValue === null || rawValue === undefined) {
        continue; // 静默丢弃
      }
      const valueStr = String(rawValue);
      if (/[\r\n]/.test(valueStr)) {
        result.errMsg = 'invalid header';
        return result;
      }
      result.value.set(name, valueStr);
    }
    result.ok = true;
    return result;
  }

  /** Origin 大小写不敏感注入：若 header 中不存在 origin 则补上（仅 origin 部分：scheme://host[:port]） */
  export function injectOriginIfMissing(headers: Map<string, string>, scheme: string, host: string): void {
    let hasOrigin = false;
    headers.forEach((_v, k) => {
      if (k.toLowerCase() === 'origin') {
        hasOrigin = true;
      }
    });
    if (!hasOrigin) {
      const originScheme = scheme === 'wss:' ? 'https' : 'http';
      headers.set('Origin', `${originScheme}://${stripDefaultPort(host, scheme)}`);
    }
  }

  export function validateCloseCode(raw: Object | undefined | null): CloseCodeValidationResult {
    const result = new CloseCodeValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      result.value = DEFAULT_CLOSE_CODE;
      return result;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      result.errMsg = 'invalid code';
      return result;
    }
    if (raw !== 1000 && (raw < 3000 || raw > 4999)) {
      result.errMsg = 'invalid code';
      return result;
    }
    result.ok = true;
    result.value = raw;
    return result;
  }

  export function validateCloseReason(raw: Object | undefined | null): CloseReasonValidationResult {
    const result = new CloseReasonValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      result.value = '';
      return result;
    }
    if (typeof raw !== 'string') {
      result.errMsg = 'reason must be a string';
      return result;
    }
    const byteLen = utf8ByteLength(raw);
    if (byteLen > MAX_REASON_UTF8_BYTES) {
      result.errMsg = 'reason must not exceed 123 UTF-8 bytes';
      return result;
    }
    result.ok = true;
    result.value = raw;
    return result;
  }
}

/** ------------------------------------------------------------------ */
/** 一次性回调（success/fail/complete）—— 与 DMPContainerBridgesModule 的
 *  invokeSuccessCallback/invokeFailureCallback 完全同构，独立实现使 Manager
 *  不依赖桥模块实例即可直接驱动 callback，便于单测与异步回调复用。 */
/** ------------------------------------------------------------------ */

function invokeComplete(callback: DMPBridgeCallback): void {
  if (callback) {
    callback(new DMPMap(), DMPBridgeCallbackType.Complete);
  }
}

function invokeSuccess(callback: DMPBridgeCallback, param: DMPMap | undefined | null): void {
  if (callback) {
    callback(param ? param : new DMPMap(), DMPBridgeCallbackType.Success);
  }
  invokeComplete(callback);
}

function invokeFail(callback: DMPBridgeCallback, errMsg: string): void {
  if (callback) {
    // 不能套一层 {data:{errMsg}}：callMethodsNext 把 param.toObject() 原样透传为
    // triggerCallback 的 args，中间没有解包 data 的步骤，套一层会导致回调侧
    // res.errMsg 读出 undefined。本文件是 .ts，ArkTS 规则禁止 import .ets，无法直接
    // 复用 DMPContainerBridgesModule.ets 的 invokeFailureCallback，这里保持一份行为
    // 等价的独立实现，同样采用 additive 约定（仅当顶层 errMsg 尚未预置时才写入）。
    const param = new DMPMap();
    if (!param.hasKey('errMsg')) {
      param.set('errMsg', errMsg);
    }
    callback(param, DMPBridgeCallbackType.Fail);
  }
  invokeComplete(callback);
}

/** ------------------------------------------------------------------ */
/** 数据模型 */
/** ------------------------------------------------------------------ */

class DMPWebSocketListenerSet {
  private ids: string[] = [];

  add(id: string): void {
    if (this.ids.indexOf(id) === -1) {
      this.ids.push(id);
    }
  }

  removeId(id: string): void {
    const idx = this.ids.indexOf(id);
    if (idx !== -1) {
      this.ids.splice(idx, 1);
    }
  }

  clear(): void {
    this.ids = [];
  }

  snapshot(): string[] {
    return this.ids.slice();
  }
}

class DMPSocketListeners {
  open: DMPWebSocketListenerSet = new DMPWebSocketListenerSet();
  message: DMPWebSocketListenerSet = new DMPWebSocketListenerSet();
  error: DMPWebSocketListenerSet = new DMPWebSocketListenerSet();
  close: DMPWebSocketListenerSet = new DMPWebSocketListenerSet();

  get(event: string): DMPWebSocketListenerSet {
    if (event === 'open') {
      return this.open;
    }
    if (event === 'message') {
      return this.message;
    }
    if (event === 'error') {
      return this.error;
    }
    return this.close;
  }
}

class DMPLegacySlots {
  private open: string = '';
  private message: string = '';
  private error: string = '';
  private close: string = '';

  get(event: string): string {
    if (event === 'open') {
      return this.open;
    }
    if (event === 'message') {
      return this.message;
    }
    if (event === 'error') {
      return this.error;
    }
    return this.close;
  }

  set(event: string, id: string): void {
    if (event === 'open') {
      this.open = id;
    } else if (event === 'message') {
      this.message = id;
    } else if (event === 'error') {
      this.error = id;
    } else {
      this.close = id;
    }
  }

  clearAll(): void {
    this.open = '';
    this.message = '';
    this.error = '';
    this.close = '';
  }
}

class DMPSocketEntry {
  socketId: string = '';
  transport: DMPSocketTransport | null = null;
  state: DMPSocketState = DMPSocketState.CREATED;
  opened: boolean = false;
  errorEmitted: boolean = false;
  cancelled: boolean = false;
  connectTimerHandle: number = -1;
  idleTimerHandle: number = -1;
  requestedCloseCode: number = DEFAULT_CLOSE_CODE;
  requestedCloseReason: string = '';
  hasRequestedClose: boolean = false;
  listeners: DMPSocketListeners = new DMPSocketListeners();
  responseHeader: Map<string, string> = new Map<string, string>();
  fetchStart: number = 0;
  openedAt: number = 0;
  /** 已派发过的 open 载荷，用于补发给连上之后才注册的 open 监听，见 onSocketEvent。 */
  openPayload: object | null = null;
}

/** 终态事件补发记录的上限。按最多 5 条并发连接算，留够几轮用例的量即可。 */
const TERMINAL_REPLAY_CAPACITY = 32;

class DMPOwnerState {
  appId: string = '';
  appIndex: number = -1;
  sockets: Map<string, DMPSocketEntry> = new Map<string, DMPSocketEntry>();
  legacyBoundSocketId: string = '';
  legacySlots: DMPLegacySlots = new DMPLegacySlots();
  backgrounded: boolean = false;
  graceTimerHandle: number = -1;
  /**
   * 已经派发过的终态事件载荷，键是 `${socketId}|${event}`（event 只会是 error 或 close）。
   * 连接进终态时条目就从 sockets 里删掉了，之后到达的监听注册再也找不到它；而
   * connectSocket 一返回原生就开始拨号，连本机的连接被拒都可能比调用方的 onError
   * 注册消息更早到（实测差 1 毫秒），这个事件就永久丢了。这里按插入顺序保留最近
   * 若干条，注册时补发一次。
   */
  terminalReplay: Map<string, object> = new Map<string, object>();
}

/** ------------------------------------------------------------------ */
/** Manager */
/** ------------------------------------------------------------------ */

let sharedManagerInstance: DMPWebSocketManager | null = null;

export class DMPWebSocketManager {
  private owners: Map<string, DMPOwnerState> = new Map<string, DMPOwnerState>();
  /** 全局后台标记（对齐 dimina-kit index.ts 的全局 backgrounded 语义）：
   *  app 已进入后台期间才首次创建的 owner（例如后台宽限窗口内小程序才第一次调用
   *  socket API）必须继承这个标记，而不是默认 backgrounded=false —— 否则该次
   *  connectSocket 会在后台期间错误地成功，且因为宽限计时器从未为这个 owner 启动过，
   *  永远不会被撕毁。*/
  private globallyBackgrounded: boolean = false;
  private transportFactory: DMPSocketTransportFactory = defaultTransportFactory;
  private scheduler: DMPTimerScheduler = new DMPRealTimerScheduler();
  /** 宿主级配置：空闲超时（毫秒），默认 0=关闭，不对小程序 JS 暴露 */
  private idleTimeoutMs: number = 0;
  /** 单测钩子：拦截 triggerCallback 推送，跳过对真实 DMPApp/DMPService 的依赖 */
  private eventSinkForTest: ((appIndex: number, callbackId: string, payload: object) => void) | null = null;
  /** 生产环境事件推送：由 .ets 侧（DMPContainerBridgesModule+WebSocket）注入，
   *  实现为 DMPChannelProxyNext.ContainerToService 包一层 triggerCallback 消息 */
  private productionEmitter: ((appIndex: number, callbackId: string, payload: object) => void) | null = null;
  /** 生产环境日志：由 .ets 侧注入 DMPLogger，未注入时退化为 console，便于单测/裸 .ts 环境使用 */
  private productionLogger: { d: (tag: string, msg: string) => void, e: (tag: string, msg: string) => void } = {
    d: (_tag: string, msg: string) => console.log(msg),
    e: (_tag: string, msg: string) => console.error(msg),
  };

  setProductionEmitter(emitter: (appIndex: number, callbackId: string, payload: object) => void): void {
    this.productionEmitter = emitter;
  }

  setProductionLogger(logger: { d: (tag: string, msg: string) => void, e: (tag: string, msg: string) => void }): void {
    this.productionLogger = logger;
  }

  static sharedInstance(): DMPWebSocketManager {
    if (!sharedManagerInstance) {
      sharedManagerInstance = new DMPWebSocketManager();
    }
    return sharedManagerInstance;
  }

  /** ---------------- owner 生命周期 ---------------- */

  attachOwner(appId: string, appIndex: number): void {
    const owner = this.getOrCreateOwner(appId);
    owner.appIndex = appIndex;
  }

  disposeOwner(appId: string): void {
    const owner = this.owners.get(appId);
    if (!owner) {
      return;
    }
    if (owner.graceTimerHandle !== -1) {
      this.scheduler.cancel(owner.graceTimerHandle);
      owner.graceTimerHandle = -1;
    }
    owner.sockets.forEach((entry) => {
      this.teardownEntryTimers(entry);
      this.detachTransport(entry);
      entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: '' }, () => {
      });
    });
    owner.sockets.clear();
    owner.legacyBoundSocketId = '';
    owner.legacySlots.clearAll();
    this.owners.delete(appId);
  }

  setAllBackgrounded(backgrounded: boolean): void {
    this.globallyBackgrounded = backgrounded;
    this.owners.forEach((owner) => {
      this.setBackgroundedForOwner(owner, backgrounded);
    });
  }

  /** ---------------- 宿主级配置 ---------------- */

  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = ms > 0 ? ms : 0;
  }

  /** ---------------- connectSocket ---------------- */

  connectSocket(appId: string, appIndex: number, params: DMPMap, callback: DMPBridgeCallback): void {
    this.attachOwner(appId, appIndex); // 自愈：resetAndStartDimina 不会重建桥模块实例
    const owner = this.getOrCreateOwner(appId);

    if (owner.backgrounded) {
      invokeFail(callback, 'connectSocket:fail interrupted');
      return;
    }

    const socketId = params.getString('socketId') ?? '';
    if (!socketId || owner.sockets.has(socketId)) {
      invokeFail(callback, 'connectSocket:fail invalid socketId');
      return;
    }

    if (owner.sockets.size >= MAX_CONNECTIONS_PER_OWNER) {
      invokeFail(callback, `connectSocket:fail reach max websocket connect count ${MAX_CONNECTIONS_PER_OWNER}`);
      return;
    }

    const urlResult = DMPWebSocketValidation.validateUrl(params.get('url'));
    if (!urlResult.ok) {
      invokeFail(callback, `connectSocket:fail ${urlResult.errMsg}`);
      return;
    }

    const timeoutResult = DMPWebSocketValidation.validateTimeout(params.get('timeout'));
    if (!timeoutResult.ok) {
      invokeFail(callback, `connectSocket:fail ${timeoutResult.errMsg}`);
      return;
    }

    const protocolsResult = DMPWebSocketValidation.validateProtocols(params.get('protocols'));
    if (!protocolsResult.ok) {
      invokeFail(callback, `connectSocket:fail ${protocolsResult.errMsg}`);
      return;
    }

    const headerResult = DMPWebSocketValidation.validateHeader(params.get('header'));
    if (!headerResult.ok) {
      invokeFail(callback, `connectSocket:fail ${headerResult.errMsg}`);
      return;
    }

    DMPWebSocketValidation.injectOriginIfMissing(headerResult.value, urlResult.scheme, urlResult.host);

    // 9. 校验全过：登记条目（CREATED）、绑定 legacy、启动 connectTimer、立即 success，
    //    拨号通过微任务排队（best-effort 的同 tick 竞态取消窗口）。
    const entry = new DMPSocketEntry();
    entry.socketId = socketId;
    entry.fetchStart = this.scheduler.now();
    owner.sockets.set(socketId, entry);

    if (!owner.legacyBoundSocketId || !owner.sockets.has(owner.legacyBoundSocketId)) {
      owner.legacyBoundSocketId = socketId;
    }

    invokeSuccess(callback, new DMPMap({ errMsg: 'connectSocket:ok' }));

    entry.connectTimerHandle = this.scheduler.schedule(() => {
      this.handleConnectTimeout(owner, entry);
    }, timeoutResult.value);

    Promise.resolve().then(() => {
      if (entry.cancelled) {
        return; // CREATED 期已被 close 抢占，拨号任务放弃，不碰网络
      }
      this.dial(owner, entry, urlResult, headerResult.value, protocolsResult.value);
    });
  }

  /** ---------------- sendSocketMessage ---------------- */

  sendSocketMessage(appId: string, params: DMPMap, callback: DMPBridgeCallback): void {
    const owner = this.getOrCreateOwner(appId);

    if (owner.backgrounded) {
      invokeFail(callback, 'sendSocketMessage:fail interrupted');
      return;
    }

    const hasSocketId = params.hasOwnKey('socketId');
    const entry = hasSocketId
      ? owner.sockets.get(params.getString('socketId') ?? '')
      : owner.sockets.get(owner.legacyBoundSocketId);

    if (!entry || entry.state !== DMPSocketState.OPEN) {
      invokeFail(callback, 'sendSocketMessage:fail WebSocket is not connected');
      return;
    }

    const isBuffer = params.getBoolean('isBuffer') === true;
    const dataRaw = params.get('data');

    if (typeof dataRaw !== 'string') {
      invokeFail(callback, 'sendSocketMessage:fail data must be string or ArrayBuffer');
      return;
    }

    if (isBuffer) {
      let bytes: Uint8Array;
      try {
        bytes = base64Decode(dataRaw);
      } catch (e) {
        invokeFail(callback, 'sendSocketMessage:fail data must be string or ArrayBuffer');
        return;
      }
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      entry.transport?.send(buffer, (err: BusinessError, ok: boolean) => {
        this.handleSendResult(owner, entry, err, ok, callback);
      });
    } else {
      entry.transport?.send(dataRaw, (err: BusinessError, ok: boolean) => {
        this.handleSendResult(owner, entry, err, ok, callback);
      });
    }
  }

  private handleSendResult(owner: DMPOwnerState, entry: DMPSocketEntry, err: BusinessError, ok: boolean,
    callback: DMPBridgeCallback): void {
    if (err) {
      invokeFail(callback, `sendSocketMessage:fail ${err.message || 'WebSocket connection failed'}`);
      return;
    }
    if (!ok) {
      invokeFail(callback, 'sendSocketMessage:fail WebSocket is not connected');
      return;
    }
    this.resetIdleTimerIfNeeded(owner, entry);
    invokeSuccess(callback, new DMPMap({ errMsg: 'sendSocketMessage:ok' }));
  }

  /** ---------------- closeSocket ---------------- */

  closeSocket(appId: string, params: DMPMap, callback: DMPBridgeCallback): void {
    const owner = this.getOrCreateOwner(appId);
    if (params.hasOwnKey('socketId')) {
      this.closeTaskSocket(owner, params, callback);
    } else {
      this.closeLegacySocket(owner, params, callback);
    }
  }

  private closeTaskSocket(owner: DMPOwnerState, params: DMPMap, callback: DMPBridgeCallback): void {
    if (owner.backgrounded) {
      invokeFail(callback, 'closeSocket:fail interrupted');
      return;
    }

    const socketId = params.getString('socketId') ?? '';
    const entry = owner.sockets.get(socketId);
    // CLOSING 的条目仍在 map 中，但第二次 close 收敛为 not connected，避免双 close 事件
    if (!entry || entry.state === DMPSocketState.CLOSING) {
      invokeFail(callback, 'closeSocket:fail WebSocket is not connected');
      return;
    }

    const codeResult = DMPWebSocketValidation.validateCloseCode(params.get('code'));
    if (!codeResult.ok) {
      invokeFail(callback, `closeSocket:fail ${codeResult.errMsg}`);
      return;
    }
    const reasonResult = DMPWebSocketValidation.validateCloseReason(params.get('reason'));
    if (!reasonResult.ok) {
      invokeFail(callback, `closeSocket:fail ${reasonResult.errMsg}`);
      return;
    }

    this.performClientClose(owner, entry, codeResult.value, reasonResult.value);
    invokeSuccess(callback, new DMPMap({ errMsg: 'closeSocket:ok' }));
  }

  private closeLegacySocket(owner: DMPOwnerState, params: DMPMap, callback: DMPBridgeCallback): void {
    if (owner.backgrounded) {
      invokeFail(callback, 'closeSocket:fail interrupted');
      return;
    }

    const boundId = owner.legacyBoundSocketId;
    const boundEntry = boundId ? owner.sockets.get(boundId) : undefined;

    // existence and "already closing" must be checked BEFORE code/reason, same as task
    // mode above — an invalid code/reason must never preempt the mandatory "not
    // connected" + sweep path for a dead/closing legacy target.
    if (!boundEntry || boundEntry.state === DMPSocketState.CLOSING) {
      invokeFail(callback, 'closeSocket:fail WebSocket is not connected');
    } else {
      const codeResult = DMPWebSocketValidation.validateCloseCode(params.get('code'));
      const reasonResult = DMPWebSocketValidation.validateCloseReason(params.get('reason'));
      if (!codeResult.ok) {
        invokeFail(callback, `closeSocket:fail ${codeResult.errMsg}`);
      } else if (!reasonResult.ok) {
        invokeFail(callback, `closeSocket:fail ${reasonResult.errMsg}`);
      } else {
        this.performClientClose(owner, boundEntry, codeResult.value, reasonResult.value);
        invokeSuccess(callback, new DMPMap({ errMsg: 'closeSocket:ok' }));
      }
    }

    // 扫尾：无论绑定结果如何，其余所有非 CLOSED 连接用默认参数关闭
    const remaining = Array.from(owner.sockets.values()).filter((e) => e.socketId !== boundId);
    for (let i = 0; i < remaining.length; i++) {
      this.performClientClose(owner, remaining[i], DEFAULT_CLOSE_CODE, '');
    }
  }

  /** 客户端主动关闭的统一入口：按当前 state 分流 CREATED / CONNECTING / OPEN */
  private performClientClose(owner: DMPOwnerState, entry: DMPSocketEntry, code: number, reason: string): void {
    if (entry.state === DMPSocketState.CLOSING) {
      // 已有一次 close 握手在途（可能来自遗留 API 扫尾命中一个正在任务态关闭中的
      // 绑定/剩余连接）：no-op，既不重复发起第二次 transport.close()，也不覆盖
      // requestedCloseCode/Reason —— 否则最终 close 事件会报告"这一次"而不是
      // "第一次"已在途请求的 code/reason，是实打实的数据污染（对齐 Android
      // WebSocketManager.kt 对 CLOSING 目标的同款 no-op）。
      return;
    }

    entry.requestedCloseCode = code;
    entry.requestedCloseReason = reason;
    entry.hasRequestedClose = true;

    if (entry.state === DMPSocketState.CREATED) {
      entry.cancelled = true;
      this.teardownEntryTimers(entry);
      owner.sockets.delete(entry.socketId);
      this.dispatchEvent(owner, entry, 'close', { code, reason });
      return;
    }

    if (entry.state === DMPSocketState.CONNECTING) {
      entry.cancelled = true;
      this.teardownEntryTimers(entry);
      owner.sockets.delete(entry.socketId);
      this.detachTransport(entry);
      entry.transport?.close({ code, reason }, () => {
      });
      this.dispatchEvent(owner, entry, 'close', { code, reason });
      return;
    }

    // OPEN：发起真实关闭握手，收尾（transport 的 close 事件）时才发 close
    entry.state = DMPSocketState.CLOSING;
    entry.transport?.close({ code, reason }, () => {
    });
  }

  /** ---------------- onXxx / offXxx ---------------- */

  onSocketEvent(event: string, appId: string, params: DMPMap, callback: DMPBridgeCallback): void {
    const owner = this.getOrCreateOwner(appId);
    const callbackId = params.getString('callback') ?? '';

    if (callbackId) {
      if (params.hasOwnKey('socketId')) {
        const socketId = params.getString('socketId') ?? '';
        const entry = owner.sockets.get(socketId);
        entry?.listeners.get(event).add(callbackId);
        // wx.connectSocket 一返回原生就开始拨号，本机回环几毫秒就能握手完成或被拒，
        // 调用方紧接着挂上的 onOpen / onError 有可能比事件晚到，那样这个事件就永远
        // 收不到了。连接已经开着就把 open 补给它；终态事件已经派发过就从记录里补，
        // 此时条目早已从 sockets 删掉，只能靠 owner 上的记录。
        if (event === 'open' && entry && entry.state === DMPSocketState.OPEN && entry.openPayload !== null) {
          this.pushEvent(owner, callbackId, entry.openPayload);
        } else if (event === 'error' || event === 'close') {
          const replay = owner.terminalReplay.get(`${socketId}|${event}`);
          if (replay) {
            this.pushEvent(owner, callbackId, replay);
          }
        }
      } else {
        owner.legacySlots.set(event, callbackId);
      }
    }
    // on* 注册本身总是"成功"（fe 通用 invokeAPI 会为其自动包一层 Promise，见 fe/.../api/common/index.js
    // 的 canReturnPromise 分支；触发一次 success 以清理该 Promise 对应的临时回调项，避免泄漏）。
    // 载荷带 errMsg（对齐 Android/iOS 的 "onSocketXxx:ok" 约定，而不是空 Promise resolve({})）。
    invokeSuccess(callback, new DMPMap({ errMsg: `${this.legacyApiName('on', event)}:ok` }));
  }

  offSocketEvent(event: string, appId: string, params: DMPMap, callback: DMPBridgeCallback): void {
    const owner = this.getOrCreateOwner(appId);
    const callbackId = params.getString('callback') ?? '';

    if (params.hasOwnKey('socketId')) {
      const entry = owner.sockets.get(params.getString('socketId') ?? '');
      if (entry) {
        if (callbackId) {
          entry.listeners.get(event).removeId(callbackId);
        } else {
          // fe off* quirk：原始函数跨桥丢失，收到的实际只有 {socketId} -> 清空该事件全部监听
          entry.listeners.get(event).clear();
        }
      }
    } else {
      // fe 未导出全局 off*，此路径目前不会被触发，仅做防御性清空
      owner.legacySlots.set(event, '');
    }
    invokeSuccess(callback, new DMPMap({ errMsg: `${this.legacyApiName('off', event)}:ok` }));
  }

  /** "on"/"off" + Capitalize(event) -> "onSocketOpen"/"offSocketMessage"/etc, matching the actual bridge API name. */
  private legacyApiName(prefix: string, event: string): string {
    const capitalized = event.length > 0 ? event.charAt(0).toUpperCase() + event.slice(1) : event;
    return `${prefix}Socket${capitalized}`;
  }

  /** ---------------- 拨号与事件回调 ---------------- */

  private dial(owner: DMPOwnerState, entry: DMPSocketEntry, urlResult: DMPWebSocketValidation.UrlValidationResult,
    headers: Map<string, string>, protocols: string[]): void {
    if (!owner.sockets.has(entry.socketId)) {
      return; // 理论上不会发生（cancelled 分支已在上层拦下），防御
    }
    this.productionLogger.d('Bridge', `DMPWebSocketManager dial socketId=${entry.socketId} url=${urlResult.rawUrl}`);
    entry.state = DMPSocketState.CONNECTING;
    const transport = this.transportFactory();
    entry.transport = transport;

    const headerObj: { [key: string]: string } = {};
    headers.forEach((v, k) => {
      headerObj[k] = v;
    });

    const options: webSocket.WebSocketRequestOptions = { header: headerObj };
    if (protocols.length > 0) {
      // SDK 仅提供单个 protocol 字段（无原生多值子协议数组），按 Sec-WebSocket-Protocol
      // 线上语义以逗号连接多个候选。
      options.protocol = protocols.join(', ');
    }

    transport.on('headerReceive', (respHeaders: webSocket.ResponseHeaders) => {
      this.handleHeaderReceive(owner, entry, respHeaders);
    });
    transport.on('open', () => {
      this.handleOpen(owner, entry);
    });
    transport.on('message', (err: BusinessError, data: string | ArrayBuffer) => {
      this.handleMessage(owner, entry, data);
    });
    transport.on('close', (err: BusinessError, result: webSocket.CloseResult) => {
      this.handleClose(owner, entry, result);
    });
    transport.on('error', (err: BusinessError) => {
      this.handleTransportError(owner, entry, err);
    });

    transport.connect(urlResult.rawUrl, options, (err: BusinessError) => {
      // connect() 回调与 on('open')/on('error') 事件在真机上是否会重复触发同一结果未经真机验证；
      // handleTransportError 内部有 errorEmitted 门闩，双触发也只会生效一次，安全防御。
      if (err) {
        this.handleTransportError(owner, entry, err);
      }
    });
  }

  private handleHeaderReceive(owner: DMPOwnerState, entry: DMPSocketEntry,
    headers: webSocket.ResponseHeaders): void {
    if (!owner.sockets.has(entry.socketId)) {
      return;
    }
    Object.keys(headers).forEach((k) => {
      const v = headers[k];
      if (typeof v === 'string') {
        entry.responseHeader.set(k, v);
      } else if (Array.isArray(v)) {
        entry.responseHeader.set(k, (v as string[]).join(', '));
      }
    });
  }

  private handleOpen(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    if (!owner.sockets.has(entry.socketId) || entry.cancelled || entry.opened) {
      return;
    }
    entry.opened = true;
    entry.state = DMPSocketState.OPEN;
    entry.openedAt = this.scheduler.now();
    this.teardownConnectTimer(entry);
    this.startIdleTimerIfNeeded(owner, entry);

    const headerObj: { [key: string]: string } = {};
    entry.responseHeader.forEach((v, k) => {
      headerObj[k] = v;
    });

    const payload: object = { header: headerObj, profile: this.completeProfile(entry) };
    entry.openPayload = payload;
    this.dispatchEvent(owner, entry, 'open', payload);
  }

  private handleMessage(owner: DMPOwnerState, entry: DMPSocketEntry, data: string | ArrayBuffer): void {
    if (!owner.sockets.has(entry.socketId)) {
      return;
    }
    this.resetIdleTimerIfNeeded(owner, entry);
    if (typeof data === 'string') {
      this.dispatchEvent(owner, entry, 'message', { data });
    } else {
      const bytes = new Uint8Array(data);
      const b64 = base64Encode(bytes);
      this.dispatchEvent(owner, entry, 'message', { data: b64, isBuffer: true });
    }
  }

  private handleClose(owner: DMPOwnerState, entry: DMPSocketEntry, result: webSocket.CloseResult): void {
    if (!owner.sockets.has(entry.socketId)) {
      return; // 未知/已移除 socketId 的传输事件一律丢弃
    }
    this.teardownEntryTimers(entry);
    owner.sockets.delete(entry.socketId);
    if (!entry.opened) {
      // 未 open 的连接永不收 close（正常应已由 error 路径处理，这里仅防御）
      return;
    }
    const code = entry.hasRequestedClose ? entry.requestedCloseCode : (result?.code ?? DEFAULT_CLOSE_CODE);
    const reason = entry.hasRequestedClose ? entry.requestedCloseReason : (result?.reason ?? '');
    this.dispatchEvent(owner, entry, 'close', { code, reason });
  }

  private handleTransportError(owner: DMPOwnerState, entry: DMPSocketEntry, err: BusinessError | null): void {
    if (!owner.sockets.has(entry.socketId) || entry.cancelled || entry.errorEmitted) {
      return;
    }
    entry.errorEmitted = true;
    const msg = this.normalizeConnectErrorMessage(err);

    if (!entry.opened) {
      this.teardownEntryTimers(entry);
      owner.sockets.delete(entry.socketId);
      this.dispatchEvent(owner, entry, 'error', { errMsg: msg });
      return;
    }
    // 已 open 的连接：不能依赖 @ohos.net.webSocket 在 error 之后一定会补发 close 事件
    // （未经真机验证的假设——若不补发，条目会永久占用 5 并发名额之一）。这里立即
    // 本地合成 close 并释放名额；若稍后仍收到 transport 的原生 close 回调，entry 已
    // 从 map 移除，会被 handleClose 顶部的存在性检查安全丢弃。
    this.teardownEntryTimers(entry);
    owner.sockets.delete(entry.socketId);
    this.detachTransport(entry);
    // 仅摘监听器不够——真实的原生 transport 资源本身也必须主动关掉，否则监听器已摘
    // 但底层 socket 可能仍然存活，造成资源泄漏。回调用空函数吞掉任何失败：transport
    // 已经处于错误状态，close 本身失败是预期且无害的。
    entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: '' }, () => {});
    // 若一次 CLIENT 发起的 close 已在途，transport 失败只应报告 close（携带调用方
    // 请求的 code/reason），不应再报 error；只有真正未经请求的失败才触发 error 事件
    // 及合成的 1006 兜底 code/reason。
    const clientCloseInFlight = entry.hasRequestedClose;
    if (!clientCloseInFlight) {
      this.dispatchEvent(owner, entry, 'error', { errMsg: msg });
    }
    // close 的 reason 用原始消息（不带 "connectSocket:fail " 前缀），对齐 Android
    // handleTransportFailure 的约定：error 的 errMsg 是 API 风格的规范化消息，
    // close 的 reason 是原始传输层消息。
    const code = clientCloseInFlight ? entry.requestedCloseCode : 1006;
    const reason = clientCloseInFlight ? entry.requestedCloseReason : (err?.message ?? '');
    this.dispatchEvent(owner, entry, 'close', { code, reason });
  }

  private handleConnectTimeout(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    entry.connectTimerHandle = -1;
    if (!owner.sockets.has(entry.socketId) || entry.opened || entry.errorEmitted) {
      return;
    }
    entry.errorEmitted = true;
    entry.cancelled = true;
    owner.sockets.delete(entry.socketId);
    this.detachTransport(entry);
    entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: '' }, () => {
    });
    this.dispatchEvent(owner, entry, 'error', { errMsg: 'connectSocket:fail timed out' });
  }

  private normalizeConnectErrorMessage(err: BusinessError | null): string {
    const raw = err?.message ?? '';
    this.productionLogger.e('Bridge', `DMPWebSocketManager transport error: ${raw}`);
    if (!raw) {
      return 'connectSocket:fail WebSocket connection failed';
    }
    if (raw.toLowerCase().indexOf('timeout') !== -1) {
      return 'connectSocket:fail timeout';
    }
    return `connectSocket:fail ${raw}`;
  }

  /** ---------------- 后台/前台 ---------------- */

  private setBackgroundedForOwner(owner: DMPOwnerState, backgrounded: boolean): void {
    if (owner.backgrounded === backgrounded) {
      return;
    }
    owner.backgrounded = backgrounded;
    if (backgrounded) {
      owner.graceTimerHandle = this.scheduler.schedule(() => {
        this.handleBackgroundGraceExpired(owner);
      }, DEFAULT_BACKGROUND_GRACE_MS);
    } else if (owner.graceTimerHandle !== -1) {
      this.scheduler.cancel(owner.graceTimerHandle);
      owner.graceTimerHandle = -1;
    }
  }

  private handleBackgroundGraceExpired(owner: DMPOwnerState): void {
    owner.graceTimerHandle = -1;
    if (!owner.backgrounded) {
      return; // 到期前已回前台，安全防御（正常已被 cancel 拦下）
    }
    const entries = Array.from(owner.sockets.values());
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.teardownEntryTimers(entry);
      owner.sockets.delete(entry.socketId);
      this.detachTransport(entry);
      if (entry.opened) {
        // 1006 是 RFC6455 保留的"仅供上报"码，不能真的发给 wire（本文件自身的
        // validateCloseCode 也会拒绝 1006 作为出站 code）：真实 @ohos.net.webSocket
        // SDK 可能拒绝或静默忽略这次 close 调用。JS 侧上报的 code 与实际发给
        // transport 的 code 在这里刻意解耦——wire 侧用合法的默认 code 终止连接，
        // JS 侧仍收到 {1006, 'interrupted'}。
        entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: 'interrupted' }, () => {
        });
        this.dispatchEvent(owner, entry, 'close', { code: 1006, reason: 'interrupted' });
      } else if (!entry.errorEmitted) {
        entry.errorEmitted = true;
        entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: '' }, () => {
        });
        this.dispatchEvent(owner, entry, 'error', { errMsg: 'connectSocket:fail interrupted' });
      }
      // 已 errorEmitted 的握手中条目：静默回收，不再发任何事件
    }
  }

  /** ---------------- 空闲超时 ---------------- */

  private startIdleTimerIfNeeded(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }
    this.resetIdleTimerIfNeeded(owner, entry);
  }

  private resetIdleTimerIfNeeded(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }
    if (entry.idleTimerHandle !== -1) {
      this.scheduler.cancel(entry.idleTimerHandle);
    }
    entry.idleTimerHandle = this.scheduler.schedule(() => {
      this.handleIdleTimeout(owner, entry);
    }, this.idleTimeoutMs);
  }

  private handleIdleTimeout(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    entry.idleTimerHandle = -1;
    if (!owner.sockets.has(entry.socketId)) {
      return;
    }
    if (entry.state !== DMPSocketState.OPEN) {
      // 已经在 CLOSING（用户发起的 close 握手在途）：一个待决的用户 close 请求
      // 必须赢过空闲超时，不能被这里覆盖成 {1006,'idle timeout'}；真正的 close
      // 事件交给 handleClose 按用户请求的 code/reason 上报。
      return;
    }
    this.teardownEntryTimers(entry);
    owner.sockets.delete(entry.socketId);
    this.detachTransport(entry);
    // 同背景宽限撕毁：1006 不能真的发给 wire，wire 侧用合法默认 code 终止，JS 侧仍报 1006。
    entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: 'idle timeout' }, () => {
    });
    this.dispatchEvent(owner, entry, 'close', { code: 1006, reason: 'idle timeout' });
  }

  /** ---------------- profile（回填规则） ---------------- */

  private completeProfile(entry: DMPSocketEntry): object {
    // @ohos.net.webSocket 未暴露 DNS/TCP 分段时间戳钩子，除 fetchStart/cost 外均为回填值（best-effort）。
    const fetchStart = entry.fetchStart;
    const openedAt = entry.openedAt;
    const connectStart = fetchStart;
    const connectEnd = openedAt;
    const domainLookUpStart = fetchStart;
    const domainLookUpEnd = domainLookUpStart;
    return {
      fetchStart,
      domainLookUpStart,
      domainLookUpEnd,
      connectStart,
      connectEnd,
      rtt: Math.max(0, connectEnd - connectStart),
      handshakeCost: Math.max(0, openedAt - connectEnd),
      cost: Math.max(0, openedAt - fetchStart),
    };
  }

  /** ---------------- 事件推送 ---------------- */

  private dispatchEvent(owner: DMPOwnerState, entry: DMPSocketEntry, event: string, payload: object): void {
    if (event === 'error' || event === 'close') {
      this.recordTerminalEvent(owner, entry.socketId, event, payload);
    }
    const ids = entry.listeners.get(event).snapshot();
    for (let i = 0; i < ids.length; i++) {
      this.pushEvent(owner, ids[i], payload);
    }
    if (owner.legacyBoundSocketId === entry.socketId) {
      const legacyId = owner.legacySlots.get(event);
      if (legacyId) {
        this.pushEvent(owner, legacyId, payload);
      }
    }
  }

  private recordTerminalEvent(owner: DMPOwnerState, socketId: string, event: string, payload: object): void {
    const key = `${socketId}|${event}`;
    owner.terminalReplay.delete(key);
    owner.terminalReplay.set(key, payload);
    while (owner.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
      const oldest = owner.terminalReplay.keys().next();
      if (oldest.done) {
        break;
      }
      owner.terminalReplay.delete(oldest.value);
    }
  }

  private pushEvent(owner: DMPOwnerState, callbackId: string, payload: object): void {
    if (!callbackId) {
      return;
    }
    if (this.eventSinkForTest) {
      this.eventSinkForTest(owner.appIndex, callbackId, payload);
      return;
    }
    if (owner.appIndex < 0 || !this.productionEmitter) {
      return;
    }
    this.productionEmitter(owner.appIndex, callbackId, payload);
  }

  /** ---------------- 内部工具 ---------------- */

  private getOrCreateOwner(appId: string): DMPOwnerState {
    let owner = this.owners.get(appId);
    if (!owner) {
      owner = new DMPOwnerState();
      owner.appId = appId;
      // 新建 owner 继承当前全局后台标记（见 globallyBackgrounded 字段注释）——没有
      // 未完成的 socket 需要撕毁，所以不启动宽限计时器，仅需保证后续 connectSocket
      // 立刻按 backgrounded 分支失败。
      owner.backgrounded = this.globallyBackgrounded;
      this.owners.set(appId, owner);
    }
    return owner;
  }

  private teardownConnectTimer(entry: DMPSocketEntry): void {
    if (entry.connectTimerHandle !== -1) {
      this.scheduler.cancel(entry.connectTimerHandle);
      entry.connectTimerHandle = -1;
    }
  }

  private teardownEntryTimers(entry: DMPSocketEntry): void {
    this.teardownConnectTimer(entry);
    if (entry.idleTimerHandle !== -1) {
      this.scheduler.cancel(entry.idleTimerHandle);
      entry.idleTimerHandle = -1;
    }
  }

  private detachTransport(entry: DMPSocketEntry): void {
    const t = entry.transport;
    if (!t) {
      return;
    }
    t.off('open');
    t.off('message');
    t.off('close');
    t.off('error');
    t.off('headerReceive');
  }

  /** ==================== 仅供 hypium 单测使用（生产路径不受影响） ==================== */

  setTransportFactoryForTest(factory: DMPSocketTransportFactory): void {
    this.transportFactory = factory;
  }

  resetTransportFactoryForTest(): void {
    this.transportFactory = defaultTransportFactory;
  }

  setSchedulerForTest(scheduler: DMPTimerScheduler): void {
    this.scheduler = scheduler;
  }

  resetSchedulerForTest(): void {
    this.scheduler = new DMPRealTimerScheduler();
  }

  setEventSinkForTest(sink: ((appIndex: number, callbackId: string, payload: object) => void) | null): void {
    this.eventSinkForTest = sink;
  }

  resetAllForTest(): void {
    this.owners.clear();
    this.idleTimeoutMs = 0;
    this.globallyBackgrounded = false;
    this.eventSinkForTest = null;
  }
}
