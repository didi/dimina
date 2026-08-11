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

/** RFC 7230 的 token，HTTP 字段名只能长这样。 */
const HTTP_TOKEN_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 请求头字段值允许的字符：水平制表符 + 可打印 ASCII（0x20~0x7E）。见 validateHeader 里
 *  的取舍说明——非 ASCII 那段是三端统一收紧，可能比微信更严。
 *
 *  与 url 的字符集规则**互不蔓延**：url 那边放行非 ASCII（中文路径合法，见
 *  URL_FORBIDDEN_CHAR），这里拒。两处方向相反是有意的，改一处时别顺手改另一处。 */
const HEADER_VALUE_ALLOWED = /^[\t\x20-\x7e]*$/;

/** 传输层错误的两条固定 errMsg，容器自己的英文串，不掺任何 SDK / OS 文本。 */
const CONNECT_FAILED_ERR_MSG = 'connectSocket:fail WebSocket connection failed';
const TIMED_OUT_ERR_MSG = 'connectSocket:fail timeout';

/**
 * NetStack 判定为超时的 `BusinessError.code`。`@ohos.net.http` 的文档里是
 * `2300028 - Operation timeout.`（NetStack 约定 2300000 + CURLE 码，28 =
 * CURLE_OPERATION_TIMEDOUT），webSocket 与 http 共用同一层 NetStack，按同一约定识别。
 *
 * `@ohos.net.webSocket` 自己的文档只列了 2302001~2302007 / 2302998 / 2302999，
 * **没有任何超时码**，所以「webSocket 是否真的会抛 2300028」未在真机验证；这条表项
 * 是按 NetStack 全域约定做的前瞻识别，识别不到时会落到通用兜底串，不会误判成别的错误。
 */
const TRANSPORT_TIMEOUT_ERROR_CODES: Set<number> = new Set<number>([2300028]);

/**
 * url 里必须先百分号编码才能出现的 ASCII 字符：裸空格、引号、尖括号、花括号、竖线、
 * 反斜杠、`^`、反引号，以及全部控制字符与 DEL。`%20` 这类已编码的写法全部合法。
 *
 * 这条**只管 ASCII**，非 ASCII（中文路径、emoji 等）一律放行：实测
 * `java.net.URI("wss://example.com/中文")` 是接受的（`getHost()` 正常返回 `example.com`），
 * Android 因此放行拨号，iOS 也显式放行 CJK 路径。改成 ASCII 白名单一刀切会把中文路径
 * 拒掉，等于换个方向重新造出三端分叉。
 *
 * 与请求头字段值的规则**互不蔓延**：HEADER_VALUE_ALLOWED 拒非 ASCII（RFC 7230 的
 * obs-text 已废弃，OkHttp 直接拒），url 这边放行非 ASCII（属 IDN / 百分号编码范畴）。
 * 两处规则方向相反是有意的，改其中一处时别顺手把另一处也改了。
 *
 * 非 ASCII **主机名**（IDN）是另一回事，不由这条管：它落在 isValidHostPort 的字符集上。
 * 目前 Harmony 与 Android 拒、iOS 放行，三端尚未统一（Android 是
 * `java.net.URI("wss://例子.测试/")` 虽然构造得出来但 `getHost()` 是 null，紧接着按空 host
 * 判 invalid url；iOS 只要求 `URLComponents` 解析出非空 host，非 ASCII 主机能过）。
 */
const URL_FORBIDDEN_CHAR = /[\x00-\x20"<>{}|\\^`\x7f]/;

/**
 * 残缺的百分号转义：`%` 后面必须紧跟两位十六进制数字，`%zz` / 结尾的 `%2` 都不合法。
 * 放行非 ASCII 之后这条尤其要在——否则 `%` 成了字符集里唯一不受约束的字符。
 */
const URL_INCOMPLETE_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

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
  // authority = [userinfo@]host[:port]，先把 userinfo/凭据剥掉；剥离后的 host[:port]
  // 再做字符集校验，拒绝 "wss://bad host"（含空格）这类不合法字符串，而不是放到真机
  // SDK 深处才报错。
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
    // 路径与查询串同样受字符集约束：parseWsUrl 只把 `#` 之前的部分整段收下，裸空格这类
    // 必须百分号编码的字符会一路漏到拨号。整串先过一遍字符集，authority 之外的部分也挡住。
    // 非 ASCII 在这里是放行的（中文路径合法），见 URL_FORBIDDEN_CHAR 的说明。
    if (URL_FORBIDDEN_CHAR.test(raw) || URL_INCOMPLETE_PERCENT_ESCAPE.test(raw)) {
      result.errMsg = 'invalid url';
      return result;
    }
    const parsed = parseWsUrl(raw);
    if (!parsed.ok) {
      result.errMsg = 'invalid url';
      return result;
    }
    if (parsed.scheme !== 'wss:') {
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
    if (typeof raw !== 'number') {
      result.errMsg = 'invalid timeout';
      return result;
    }
    const num = raw as number;
    if (!Number.isFinite(num) || num > MAX_TIMEOUT_MS) {
      result.errMsg = 'invalid timeout';
      return result;
    }
    // 有效 timeout 的下限是 1 毫秒。判据必须用截断**之后**的整数毫秒：拿原始值判的话，
    // (0,1) 之间的 0.5 会算作「指定了」，再被 Math.trunc 截成 0，排出一个立刻到期的
    // 计时器——连接还没拨号就先超时。不足 1 毫秒说不出任何截止时间，按「没指定」处理。
    const truncated = Math.trunc(num);
    if (truncated < 1) {
      result.ok = true;
      result.value = DEFAULT_TIMEOUT_MS;
      return result;
    }
    result.ok = true;
    result.value = truncated;
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
      // 只查 CRLF 挡不住 "Bad:Name" 这类字段名。按 RFC 的 token 规则拒掉，
      // 三端接受的字段名集合才是同一个。
      if (!HTTP_TOKEN_NAME.test(name)) {
        result.errMsg = 'invalid header';
        return result;
      }
      if (rawValue === null || rawValue === undefined) {
        continue; // 静默丢弃
      }
      const valueStr = String(rawValue);
      // 字段值只收水平制表符与可打印 ASCII（0x20~0x7E）。这条白名单一次挡掉三类东西：
      // CR/LF（头注入）、其余 C0 控制字符与 DEL、以及所有非 ASCII 字符。
      //
      // 非 ASCII 这一段是**三端统一收紧，可能比微信更严**，不是「对齐微信」：微信脚本层
      // 对 header 值的处理是 string 原样保留，但微信 native 收到非 ASCII 值会怎样
      // 两个源都没有覆盖。RFC 7230 里 0x80~0xFF 的 obs-text 已废弃，OkHttp 直接拒——放行的
      // 那一端连得上、拒绝的那一端连不上，同一份小程序代码在三端表现不同，比统一拒更糟。
      // 代价是：在微信上给 header 塞中文能跑的小程序，在 dimina 上会拿到 invalid header。
      if (!HEADER_VALUE_ALLOWED.test(valueStr)) {
        result.errMsg = 'invalid header';
        return result;
      }
      result.value.set(name, valueStr);
    }
    result.ok = true;
    return result;
  }

  /** 容器注入的 Referer。微信固定该头且不允许调用方设置
   *  （https://servicewechat.com/{appid}/{version}/page-frame.html），dimina 用自己的域名，
   *  与 request 那条链路（DMPHttpParamsNext.addCommonHeaderParams）保持一致。调用方传的
   *  referer 到不了这里——它在禁用头名单里，校验阶段就被丢掉了。
   *  appVersion 是小程序包的 versionCode，取不到时用 '0'，与微信对开发版/体验版/审核版的
   *  约定一致。 */
  export function refererValue(appId: string, appVersion: string): string {
    const version = appVersion.length > 0 ? appVersion : '0';
    return `https://servicedimina.com/${appId}/${version}/page-frame.html`;
  }

  /**
   * 校验 closeSocket 的 code。不传 -> 1000。只接受原生 number；值必须是有限整数，且
   * 等于 1000 或落在 [3000, 4999]，否则 errMsg 为 'invalid code'。
   */
  export function validateCloseCode(raw: Object | undefined | null): CloseCodeValidationResult {
    const result = new CloseCodeValidationResult();
    if (raw === undefined || raw === null) {
      result.ok = true;
      result.value = DEFAULT_CLOSE_CODE;
      return result;
    }

    if (typeof raw !== 'number') {
      result.errMsg = 'invalid code';
      return result;
    }
    const numeric = raw as number;

    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      result.errMsg = 'invalid code';
      return result;
    }
    if (numeric !== 1000 && (numeric < 3000 || numeric > 4999)) {
      result.errMsg = 'invalid code';
      return result;
    }
    result.ok = true;
    result.value = numeric;
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

/**
 * `complete` 收到的 res 与本次 `success` / `fail` 的那一份是同一个：调用方写
 * `complete: res => res.errMsg` 是官方文档里的常规写法，发空载荷等于这个字段不存在。
 *
 * 这三个函数是本文件私有的（与 DMPContainerBridgesModule 的
 * invokeSuccessCallback/invokeFailureCallback 同构但各自独立），只有 socket 这条链路
 * 走它们，所以这里的改动到不了其它 API。全 API 面的 complete 也缺 res，根因在桥模块
 * 那份共用 helper 上，属另一条独立的修复。
 */
function invokeComplete(callback: DMPBridgeCallback, res: DMPMap): void {
  if (callback) {
    callback(res, DMPBridgeCallbackType.Complete);
  }
}

function invokeSuccess(callback: DMPBridgeCallback, param: DMPMap | undefined | null): void {
  const res = param ? param : new DMPMap();
  if (callback) {
    callback(res, DMPBridgeCallbackType.Success);
  }
  invokeComplete(callback, res);
}

function invokeFail(callback: DMPBridgeCallback, errMsg: string): void {
  // 不能套一层 {data:{errMsg}}：callMethodsNext 把 param.toObject() 原样透传为
  // triggerCallback 的 args，中间没有解包 data 的步骤，套一层会导致回调侧
  // res.errMsg 读出 undefined。本文件是 .ts，ArkTS 规则禁止 import .ets，无法直接
  // 复用 DMPContainerBridgesModule.ets 的 invokeFailureCallback，这里保持一份行为
  // 等价的独立实现。
  const res = new DMPMap();
  res.set('errMsg', errMsg);
  if (callback) {
    callback(res, DMPBridgeCallbackType.Fail);
  }
  invokeComplete(callback, res);
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

  clearAll(): void {
    this.open.clear();
    this.message.clear();
    this.error.clear();
    this.close.clear();
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
  /** 全局 `wx.closeSocket()` 是否已接受这条连接的关闭请求，用于全局绑定换代。 */
  closedByGlobalApi: boolean = false;
  listeners: DMPSocketListeners = new DMPSocketListeners();
  responseHeader: Map<string, string> = new Map<string, string>();
  /** 小写字段名 → 该字段首次出现时的大小写，用来把同名响应头折叠到同一个键（见
   *  mergeResponseHeader）。responseHeader 的键始终是首次出现的那个写法。 */
  responseHeaderNames: Map<string, string> = new Map<string, string>();
  /** 已派发过的 open 载荷，用于补发给连上之后才注册的 open 监听，见 onSocketEvent。 */
  openPayload: object | null = null;
  /** 已经收到过本代 open 事件的 callback id；正常派发和迟到补发共用，保证同一 id 只收到一次。 */
  openDeliveredCallbackIds: string[] = [];
}

/**
 * 一条已经派发过的终态事件：载荷本身，外加已经收到过它的 callback id。正常派发和迟到
 * 补发写同一份名单，因此正常收到事件的 id 重复注册时也不会再收到陈旧补发。这份名单跟着
 * 记录一起被 terminalReplay 的容量淘汰。
 */
class DMPTerminalEvent {
  payload: object;
  deliveredCallbackIds: string[] = [];

  constructor(payload: object) {
    this.payload = payload;
  }
}

/** 终态事件补发记录的上限。按最多 5 条并发连接算，留够几轮用例的量即可。 */
const TERMINAL_REPLAY_CAPACITY = 32;

class DMPOwnerState {
  appId: string = '';
  appIndex: number = -1;
  sockets: Map<string, DMPSocketEntry> = new Map<string, DMPSocketEntry>();
  /** 这个小程序 app.json 里 `networkTimeout.connectSocket` 的毫秒值；null 表示没配这一项。 */
  appJsonConnectTimeoutMs: number | null = null;
  legacyBoundSocketId: string = '';
  /**
   * 全局 `wx.onSocketXxx` 的监听 id，结构和任务态的 entry.listeners 完全一样：有序、去重、
   * 一个事件可以有多个。当前脚本层每个事件只登记一个 callback id，再在脚本里向业务监听扇出，
   * 所以走这条路时集合里就一个 id；仍然用集合而不是单槽，是为了让登记了多个**不同** id 的
   * 调用方（宿主扩展、或直接调桥的调用方）每个都能收到，而不是后一次顶掉前一次。同一个 id
   * 重复登记仍然只收到一次。
   */
  legacySlots: DMPSocketListeners = new DMPSocketListeners();
  backgrounded: boolean = false;
  graceTimerHandle: number = -1;
  /**
   * 已经派发过的终态事件载荷，键是 `${socketId}|${event}`（event 只会是 error 或 close）。
   * 连接进终态时条目就从 sockets 里删掉了，之后到达的监听注册再也找不到它；而
   * connectSocket 一返回原生就开始拨号，连本机的连接被拒都可能比调用方的 onError
   * 注册消息更早到（实测差 1 毫秒），这个事件就永久丢了。这里按插入顺序保留最近
   * 若干条，注册时补发一次。
   */
  terminalReplay: Map<string, DMPTerminalEvent> = new Map<string, DMPTerminalEvent>();
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

  /**
   * 登记这个小程序 app.json 里 `networkTimeout.connectSocket` 的毫秒值，`connectSocketMs`
   * 为 null 表示小程序没配这一项。配置按小程序隔离，夹在调用方的 `timeout` 与
   * DEFAULT_TIMEOUT_MS 之间（见 connectSocket 里的优先级注释）。
   */
  updateNetworkTimeout(appId: string, connectSocketMs: number | null): void {
    // 非正数（以及非有限数）说不出任何截止时间，按「没配」处理，继续往下回落。
    const usable = typeof connectSocketMs === 'number' && Number.isFinite(connectSocketMs)
      && connectSocketMs > 0 && connectSocketMs <= MAX_TIMEOUT_MS;
    this.getOrCreateOwner(appId).appJsonConnectTimeoutMs = usable ? Math.trunc(connectSocketMs!) : null;
  }

  /** ---------------- connectSocket ---------------- */

  connectSocket(appId: string, appIndex: number, appVersion: string, params: DMPMap, callback: DMPBridgeCallback): void {
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

    // 官方上限统计所有尚未终态的连接，包含 CREATED、CONNECTING、OPEN 和 CLOSING。
    if (owner.sockets.size >= MAX_CONNECTIONS_PER_OWNER) {
      // 逐字两个 `fail`：微信按 `${name}:fail ${errMsg}` 拼串，而传进去的 errMsg 本身就以
      // `fail ` 开头，重复的那个词是每个小程序实际收到的字面输出，不是笔误。
      invokeFail(callback, `connectSocket:fail fail reach max websocket connect count ${MAX_CONNECTIONS_PER_OWNER}`);
      return;
    }

    const urlResult = DMPWebSocketValidation.validateUrl(params.get('url'));
    if (!urlResult.ok) {
      invokeFail(callback, `connectSocket:fail ${urlResult.errMsg}`);
      return;
    }

    const rawTimeout = params.get('timeout');
    const timeoutResult = DMPWebSocketValidation.validateTimeout(rawTimeout);
    if (!timeoutResult.ok) {
      invokeFail(callback, `connectSocket:fail ${timeoutResult.errMsg}`);
      return;
    }
    // 优先级：调用方有效的 `timeout` > app.json 的 `networkTimeout.connectSocket` > 60000。
    // 不足 1 毫秒（含 0 与负数）的 `timeout` 说不出任何截止时间，算「没指定」，继续往下
    // 回落，不就地钉成默认值。这里的下限判据必须和 validateTimeout 里的那条一致——两处
    // 用不同的门槛，就会出现「算作指定了、却拿到默认值」的错位。
    const callerSpecifiedTimeout = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
      && Math.trunc(rawTimeout) >= 1;
    const connectTimeoutMs = callerSpecifiedTimeout
      ? timeoutResult.value
      : (owner.appJsonConnectTimeoutMs ?? DEFAULT_TIMEOUT_MS);

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
    // 容器自己的 Referer：调用方传的那份已经在校验里被丢掉了，这里补上固定值。
    headerResult.value.set('Referer', DMPWebSocketValidation.refererValue(appId, appVersion));

    // 9. 校验全过：登记条目（CREATED）、绑定 legacy、启动 connectTimer、立即 success，
    //    拨号通过微任务排队（best-effort 的同 tick 竞态取消窗口）。
    // socketId 只要求当前没有同名存活连接，因此终态后的 id 可以复用。新连接已经全部
    // 校验通过后，旧连接留下的 error/close 不能再被这代监听误认为自己的事件。
    this.clearTerminalReplay(owner, socketId);
    const entry = new DMPSocketEntry();
    entry.socketId = socketId;
    owner.sockets.set(socketId, entry);

    // 多连接下的全局绑定细节未由微信公开文档定义。Dimina 保持确定性路由：全局入口接受
    // 关闭后允许新连接接管；SocketTask.close() 不改变全局绑定。
    const boundEntry = owner.legacyBoundSocketId ? owner.sockets.get(owner.legacyBoundSocketId) : undefined;
    const boundReleasedItsSlot = boundEntry !== undefined
      && boundEntry.state === DMPSocketState.CLOSING && boundEntry.closedByGlobalApi;
    if (!boundEntry || boundReleasedItsSlot) {
      owner.legacyBoundSocketId = socketId;
    }

    invokeSuccess(callback, new DMPMap({ errMsg: 'connectSocket:ok' }));

    entry.connectTimerHandle = this.scheduler.schedule(() => {
      this.handleConnectTimeout(owner, entry);
    }, connectTimeoutMs);

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
    // 发送结果可能来得很晚：连接被拆掉之后传输层还会异步回一次取消结果。owner 已经被
    // disposeOwner 摘掉的话，它对应的 JS 上下文也没了，这个回调没有地方可去，直接丢弃。
    if (this.owners.get(owner.appId) !== owner) {
      return;
    }
    if (err) {
      // 传输层自己的消息随平台与系统语言变（同一个失败在不同设备上是不同的字符串），
      // 透传出去等于没有契约。errMsg 是给小程序判定用的，统一成固定的非本地化英文串，
      // 与「回了结果但结果是失败」那条收敛到同一条文案。
      invokeFail(callback, 'sendSocketMessage:fail WebSocket is not connected');
      return;
    }
    if (!ok) {
      invokeFail(callback, 'sendSocketMessage:fail WebSocket is not connected');
      return;
    }
    // 空闲定时器只能给还挂在 owner 上、状态仍是 OPEN 的那个 entry 重排。给已经移除的 entry
    // 重排等于把它连同闭包一起留到超时才释放。
    if (owner.sockets.get(entry.socketId) === entry && entry.state === DMPSocketState.OPEN) {
      this.resetIdleTimerIfNeeded(owner, entry);
    }
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

    // 任务态入口只处理当前 SocketTask，不改变全局绑定路由。
    this.performClientClose(owner, entry, codeResult.value, reasonResult.value, false);
    invokeSuccess(callback, new DMPMap({ errMsg: 'closeSocket:ok' }));
  }

  private closeLegacySocket(owner: DMPOwnerState, params: DMPMap, callback: DMPBridgeCallback): void {
    if (owner.backgrounded) {
      invokeFail(callback, 'closeSocket:fail interrupted');
      return;
    }

    const boundId = owner.legacyBoundSocketId;
    const boundEntry = boundId ? owner.sockets.get(boundId) : undefined;

    // 官方示例明确要求在 wx.onSocketOpen 后调用。全局入口只关闭已打开的绑定连接，
    // 不取消握手中连接，也不扫描其他 SocketTask。
    if (!boundEntry || boundEntry.state !== DMPSocketState.OPEN) {
      invokeFail(callback, 'closeSocket:fail WebSocket is not connected');
      return;
    }

    const codeResult = DMPWebSocketValidation.validateCloseCode(params.get('code'));
    const reasonResult = DMPWebSocketValidation.validateCloseReason(params.get('reason'));
    if (!codeResult.ok) {
      invokeFail(callback, `closeSocket:fail ${codeResult.errMsg}`);
    } else if (!reasonResult.ok) {
      invokeFail(callback, `closeSocket:fail ${reasonResult.errMsg}`);
    } else {
      this.performClientClose(owner, boundEntry, codeResult.value, reasonResult.value, true);
      invokeSuccess(callback, new DMPMap({ errMsg: 'closeSocket:ok' }));
    }
  }

  /** 客户端主动关闭的统一入口；`fromGlobalApi` 用于记录全局绑定是否可以换代。 */
  private performClientClose(owner: DMPOwnerState, entry: DMPSocketEntry, code: number, reason: string,
    fromGlobalApi: boolean): void {
    // 在状态迁移前记录关闭入口，供后续 connectSocket 判断全局绑定是否已经让位。
    if (fromGlobalApi) {
      entry.closedByGlobalApi = true;
    }

    if (entry.state === DMPSocketState.CLOSING) {
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
        owner.sockets.get(socketId)?.listeners.get(event).add(callbackId);
        this.replayMissedEvent(owner, socketId, event, callbackId, false);
      } else {
        owner.legacySlots.get(event).add(callbackId);
        // 全局态的补发对象是当前 legacy 绑定的那条连接；没有绑定就没有可补的事件。
        if (owner.legacyBoundSocketId) {
          this.replayMissedEvent(owner, owner.legacyBoundSocketId, event, callbackId, true);
        }
      }
    }
    // on* 注册本身总是"成功"，回一次让这次桥调用在 fe 侧有确定结果，和这里其他接口一致。
    // 脚本层的 createSocketEvent 发这类请求时带 keep: true、也不带自己的 success/fail/complete，
    // 那边并没有人在等这个结果。载荷带 errMsg，对齐 Android/iOS 的 "onSocketXxx:ok" 约定。
    invokeSuccess(callback, new DMPMap({ errMsg: `${this.legacyApiName('on', event)}:ok` }));
  }

  offSocketEvent(event: string, appId: string, params: DMPMap, callback: DMPBridgeCallback): void {
    const owner = this.getOrCreateOwner(appId);
    const callbackId = params.getString('callback') ?? '';

    if (params.hasOwnKey('socketId')) {
      const socketId = params.getString('socketId') ?? '';
      const entry = owner.sockets.get(socketId);
      if (entry) {
        if (callbackId) {
          entry.listeners.get(event).removeId(callbackId);
        } else {
          // wx/SocketTask 不公开 off；内部回滚会带 id，直接兼容调用不带 id 时清空该事件。
          entry.listeners.get(event).clear();
        }
      }
      this.forgetDeliveredCallback(owner, socketId, event, callbackId);
    } else {
      // bridge-private 兼容路径：带 id 只摘这一个，不带则清空该事件。
      if (callbackId) {
        owner.legacySlots.get(event).removeId(callbackId);
      } else {
        owner.legacySlots.get(event).clear();
      }
      if (owner.legacyBoundSocketId) {
        this.forgetDeliveredCallback(owner, owner.legacyBoundSocketId, event, callbackId);
      }
    }
    invokeSuccess(callback, new DMPMap({ errMsg: `${this.legacyApiName('off', event)}:ok` }));
  }

  /**
   * 把注册时已经错过的事件补发给 callbackId。connectSocket 一返回原生就开始拨号，本机回环
   * 几毫秒就能握手完成或被拒，调用方紧接着挂上的 onOpen / onError 有可能比事件晚到，那样
   * 这个事件就永远收不到了。open 取 socketId 那条连接自己保存的载荷；error / close 是终态，
   * 那时条目早已从 sockets 删掉，只能取 owner 上的终态记录。
   *
   * 两条记录各自记着已经实际投递过的 callback id，正常派发和补发共用，所以同一个 id 即使
   * 在正常收到事件后又直接向桥重复注册，也不会收到第二份陈旧事件。message 不补发。
   *
   * `legacy` 区分注册来自全局 `wx.onSocketXxx` 还是任务态 `SocketTask.onXxx`：补发出来的
   * 载荷必须和正常派发遵守同一份字段全集，全局 open 同样只能带 `header`。
   */
  private replayMissedEvent(owner: DMPOwnerState, socketId: string, event: string, callbackId: string,
    legacy: boolean): void {
    if (event === 'open') {
      const entry = owner.sockets.get(socketId);
      if (!entry || entry.state !== DMPSocketState.OPEN || entry.openPayload === null) {
        return;
      }
      if (entry.openDeliveredCallbackIds.indexOf(callbackId) !== -1) {
        return;
      }
      entry.openDeliveredCallbackIds.push(callbackId);
      this.pushEvent(owner, callbackId,
        legacy ? this.legacyPayloadFor(event, entry.openPayload) : entry.openPayload);
      return;
    }
    if (event === 'error' || event === 'close') {
      const record = owner.terminalReplay.get(`${socketId}|${event}`);
      if (!record || record.deliveredCallbackIds.indexOf(callbackId) !== -1) {
        return;
      }
      record.deliveredCallbackIds.push(callbackId);
      this.pushEvent(owner, callbackId,
        legacy ? this.legacyPayloadFor(event, record.payload) : record.payload);
    }
  }

  /**
   * off 结束一次监听生命周期，同时回收这次生命周期在事件投递账本里的 id。逻辑层后续
   * 重新注册会生成新的 callback id；及时移除旧 id，避免长连接反复 on/off 时数组无界增长。
   */
  private forgetDeliveredCallback(owner: DMPOwnerState, socketId: string, event: string,
    callbackId: string): void {
    let deliveredIds: string[] | null = null;
    if (event === 'open') {
      deliveredIds = owner.sockets.get(socketId)?.openDeliveredCallbackIds ?? null;
    } else if (event === 'error' || event === 'close') {
      deliveredIds = owner.terminalReplay.get(`${socketId}|${event}`)?.deliveredCallbackIds ?? null;
    }
    if (!deliveredIds) {
      return;
    }
    if (!callbackId) {
      deliveredIds.length = 0;
      return;
    }
    const index = deliveredIds.indexOf(callbackId);
    if (index !== -1) {
      deliveredIds.splice(index, 1);
    }
  }

  /** "on"/"off" + Capitalize(event) -> "onSocketOpen"/"offSocketMessage"/etc, matching the actual bridge API name. */
  private legacyApiName(prefix: string, event: string): string {
    const capitalized = event.length > 0 ? event.charAt(0).toUpperCase() + event.slice(1) : event;
    return `${prefix}Socket${capitalized}`;
  }

  /**
   * `headers`（校验层产出，不折叠大小写，两个仅大小写不同的字段名各占一个键）转换成
   * `webSocket.WebSocketRequestOptions.header` 要的 `{[key:string]:string}`。
   *
   * 真机实测证实：`headers` 到这一步时两个大小写变体都还在，交给 `transport.connect()` 之后
   * 落到线上的握手报文里只剩一个——`@ohos.net.webSocket` 把 header 存成大小写不敏感的结构，
   * 折叠发生在这个方法转出去之后、我们够不到的地方，是平台的结构性限制，不是这里能修的
   * （与 iOS `URLRequest` 装不下两个仅大小写不同的字段名同属一类）。
   *
   * 但"折叠之后留哪个"不能听天由命：实测里赢家固定是 JS 属性遍历顺序中后写入的那个，这只是
   * native 内部实现细节的副作用，不是任何契约保证的行为，换一个 SDK 版本完全可能不一样。
   * 这里在转出去之前，对仅大小写不同的字段名自己按字典序选一个确定的赢家（字典序小者留），
   * 保证同一份 header 每次拨号都产出同一个结果，不把这个决定权交给 native 的内部实现。
   */
  private buildOutgoingHeaderObject(headers: Map<string, string>): { [key: string]: string } {
    const headerObj: { [key: string]: string } = {};
    const winnerNameForLowerKey: Map<string, string> = new Map<string, string>();
    headers.forEach((value: string, name: string) => {
      const lowerName = name.toLowerCase();
      const currentWinner = winnerNameForLowerKey.get(lowerName);
      if (currentWinner === undefined) {
        winnerNameForLowerKey.set(lowerName, name);
        headerObj[name] = value;
        return;
      }
      if (name < currentWinner) {
        delete headerObj[currentWinner];
        winnerNameForLowerKey.set(lowerName, name);
        headerObj[name] = value;
      }
      // 字典序不小于当前赢家，丢弃这一个变体。
    });
    return headerObj;
  }

  /** ---------------- 拨号与事件回调 ---------------- */

  private dial(owner: DMPOwnerState, entry: DMPSocketEntry, urlResult: DMPWebSocketValidation.UrlValidationResult,
    headers: Map<string, string>, protocols: string[]): void {
    if (owner.sockets.get(entry.socketId) !== entry) {
      return; // 理论上不会发生（cancelled 分支已在上层拦下），防御
    }
    // 只记 scheme 与 host：查询串里常常带鉴权 token，而设备日志是可导出的。另外两端在这条
    // 路径上根本不记 url，记全串还会让三端的日志面不一样。
    this.productionLogger.d('Bridge',
      `DMPWebSocketManager dial socketId=${entry.socketId} target=${urlResult.scheme}://${urlResult.host}`);
    entry.state = DMPSocketState.CONNECTING;
    const transport = this.transportFactory();
    entry.transport = transport;

    const headerObj = this.buildOutgoingHeaderObject(headers);

    const options: webSocket.WebSocketRequestOptions = { header: headerObj };
    if (protocols.length > 0) {
      // SDK 仅提供单个 protocol 字段（无原生多值子协议数组），按 Sec-WebSocket-Protocol
      // 线上语义以逗号连接多个候选。
      options.protocol = protocols.join(', ');
    }

    transport.on('headerReceive', (respHeaders: webSocket.ResponseHeaders) => {
      this.handleHeaderReceive(owner, entry, respHeaders);
    });
    // 这三个回调的第一个参数都是 BusinessError。带错时第二个参数可能是 undefined，
    // 不看 err 直接往下走的话：message 会把 undefined 当成二进制帧派发一条空消息，
    // close 会按默认的 1000 派发一次「正常关闭」，open 甚至会让连接进入 OPEN。
    // 有错就一律走 error 路径。
    transport.on('open', (err: BusinessError) => {
      if (err) {
        this.handleTransportError(owner, entry, err);
        return;
      }
      this.handleOpen(owner, entry);
    });
    transport.on('message', (err: BusinessError, data: string | ArrayBuffer) => {
      if (err) {
        this.handleTransportError(owner, entry, err);
        return;
      }
      this.handleMessage(owner, entry, data);
    });
    transport.on('close', (err: BusinessError, result: webSocket.CloseResult) => {
      if (err) {
        this.handleTransportError(owner, entry, err);
        return;
      }
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
    if (owner.sockets.get(entry.socketId) !== entry) {
      return;
    }
    Object.keys(headers).forEach((k) => {
      const v = headers[k];
      if (typeof v === 'string') {
        this.mergeResponseHeader(entry, k, v);
      } else if (Array.isArray(v)) {
        this.mergeResponseHeader(entry, k, (v as string[]).join(', '));
      }
    });
  }

  /**
   * 同名响应头按 RFC 7230 §3.2.2 用 `, ` 拼接，不是后到的覆盖先到的——响应头是 open
   * 载荷的一部分、业务可见，覆盖会让先到的那份（比如第一条 Set-Cookie）凭空消失。
   *
   * 合并的前提是字段名**大小写不敏感相等**：`Set-Cookie` 与 `set-cookie` 是同一个头，
   * 只拼接不折叠大小写的话，它们分两次到达仍会变成两个键。键保留首次出现的大小写。
   *
   * 注意这条规则只管**响应**头。请求头那边（validateHeader）刻意**不**折叠大小写，
   * 因为微信脚本层不折叠，两处规则不同是有意的。
   */
  private mergeResponseHeader(entry: DMPSocketEntry, name: string, value: string): void {
    const lower = name.toLowerCase();
    const firstSeenName = entry.responseHeaderNames.get(lower);
    if (firstSeenName === undefined) {
      entry.responseHeaderNames.set(lower, name);
      entry.responseHeader.set(name, value);
      return;
    }
    const existing = entry.responseHeader.get(firstSeenName) ?? '';
    entry.responseHeader.set(firstSeenName, `${existing}, ${value}`);
  }

  private handleOpen(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    if (owner.sockets.get(entry.socketId) !== entry || entry.cancelled || entry.opened) {
      return;
    }
    entry.opened = true;
    entry.state = DMPSocketState.OPEN;
    this.teardownConnectTimer(entry);
    this.startIdleTimerIfNeeded(owner, entry);

    const headerObj: { [key: string]: string } = {};
    entry.responseHeader.forEach((v, k) => {
      headerObj[k] = v;
    });

    // HarmonyOS WebSocket API 不提供官方 profile 所需的 DNS/TCP/TLS 分段指标。不能用
    // 回填时间冒充真实语义，因此本端暂不返回 profile。
    const payload: object = { header: headerObj };
    entry.openPayload = payload;
    this.dispatchEvent(owner, entry, 'open', payload);
  }

  private handleMessage(owner: DMPOwnerState, entry: DMPSocketEntry, data: string | ArrayBuffer): void {
    if (owner.sockets.get(entry.socketId) !== entry) {
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
    if (owner.sockets.get(entry.socketId) !== entry) {
      return; // 未知/已移除 socketId 的传输事件一律丢弃
    }
    this.teardownEntryTimers(entry);
    owner.sockets.delete(entry.socketId);
    this.detachTransport(entry);
    if (!entry.opened) {
      // 没 open 过的连接不该报 close，但也不能什么都不报——否则 service 内部状态无法终止，
      // 桥监听也回收不掉。按握手失败报 error，
      // 和 Android 的 terminateHandshakeWithError、iOS 的 teardown(event: .error) 对齐。
      this.dispatchEvent(owner, entry, 'error', {
        errMsg: this.normalizeConnectErrorMessage(null),
      });
      return;
    }
    const code = entry.hasRequestedClose ? entry.requestedCloseCode : (result?.code ?? DEFAULT_CLOSE_CODE);
    const reason = entry.hasRequestedClose ? entry.requestedCloseReason : (result?.reason ?? '');
    this.dispatchEvent(owner, entry, 'close', { code, reason });
  }

  private handleTransportError(owner: DMPOwnerState, entry: DMPSocketEntry, err: BusinessError | null): void {
    if (owner.sockets.get(entry.socketId) !== entry || entry.cancelled || entry.errorEmitted) {
      return;
    }
    entry.errorEmitted = true;
    const msg = this.normalizeConnectErrorMessage(err);

    if (!entry.opened) {
      this.teardownEntryTimers(entry);
      owner.sockets.delete(entry.socketId);
      // 握手失败也要摘监听。只从 map 里删条目的话，SDK 的 transport 仍然握着
      // open/message/close/error/headerReceive 五个闭包，闭包里捕获了 owner 和 entry，
      // 反复连接失败就会一直攒着不放，迟到的回调也还会进老闭包。
      this.detachTransport(entry);
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
    // 1006 这条是本地合成的：线上根本没有 close 帧，没有任何 reason 可引。reason 是
    // 业务可见的载荷字段，性质与 errMsg 相同，不能拿本地异常文本（随平台与系统语言变）
    // 去填，空串才是诚实的表示——确实一个 reason 都没收到。服务端主动关闭那条路
    // （handleClose）的 reason 来自线上 close 帧，是 RFC6455 语义，照常原样带回。
    const code = clientCloseInFlight ? entry.requestedCloseCode : 1006;
    const reason = clientCloseInFlight ? entry.requestedCloseReason : '';
    this.dispatchEvent(owner, entry, 'close', { code, reason });
  }

  private handleConnectTimeout(owner: DMPOwnerState, entry: DMPSocketEntry): void {
    entry.connectTimerHandle = -1;
    if (owner.sockets.get(entry.socketId) !== entry || entry.opened || entry.errorEmitted) {
      return;
    }
    entry.errorEmitted = true;
    entry.cancelled = true;
    owner.sockets.delete(entry.socketId);
    this.detachTransport(entry);
    entry.transport?.close({ code: DEFAULT_CLOSE_CODE, reason: '' }, () => {
    });
    // 与传输层上报的超时共用同一条 errMsg：同一件事在两条路径上给两种文案，调用方就得
    // 写两个分支去判「是不是超时」。
    this.dispatchEvent(owner, entry, 'error', { errMsg: TIMED_OUT_ERR_MSG });
  }

  /**
   * 传输层错误 → errMsg 的唯一转换点（调用点只有 handleTransportError 与 handleClose）。
   *
   * errMsg 是给小程序**判定**用的契约文本，只能由本文件这几个固定英文串构成：底层原始
   * 消息随平台与系统语言变，既不能拼进 errMsg，也不能拿来做分类——拿英文关键词去匹配
   * 一句本地化描述，等于让「选哪条固定串」由设备语言决定，契约同样不成立。原始消息与
   * 错误码只进日志。
   *
   * 分类**只看** `BusinessError.code` 这类结构化信息，零文案匹配：认得出超时码就报
   * 超时，其余（含 code 缺失）一律落通用兜底串。措辞识别哪怕锚定成整串也留着一个洞
   * ——某个 locale 下底层若吐出的就是一个裸本地化词，仍会与英文裸词分到不同的串。
   * 最常见的超时场景由容器自己的连接计时器覆盖（handleConnectTimeout），那是纯本地的
   * 结构化事实、天生与语言无关，传输层再报一次超时的边际价值不值得留这个分类器。
   */
  private normalizeConnectErrorMessage(err: BusinessError | null): string {
    const raw = err?.message ?? '';
    // 底层不一定真的给了 code（类型上必填，运行时可能缺）；-1 表示「没有可用的结构化信息」。
    const rawCode: number | undefined = err ? err.code : undefined;
    const code = typeof rawCode === 'number' ? rawCode : -1;
    this.productionLogger.e('Bridge',
      `DMPWebSocketManager transport error: code=${code} message=${raw}`);
    if (TRANSPORT_TIMEOUT_ERROR_CODES.has(code)) {
      return TIMED_OUT_ERR_MSG;
    }
    return CONNECT_FAILED_ERR_MSG;
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
    if (owner.sockets.get(entry.socketId) !== entry) {
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

  /** ---------------- 事件推送 ---------------- */

  private dispatchEvent(owner: DMPOwnerState, entry: DMPSocketEntry, event: string, payload: object): void {
    let deliveredCallbackIds: string[] | null = null;
    if (event === 'open') {
      deliveredCallbackIds = entry.openDeliveredCallbackIds;
    } else if (event === 'error' || event === 'close') {
      deliveredCallbackIds = this.recordTerminalEvent(owner, entry.socketId, event, payload).deliveredCallbackIds;
    }
    const ids = entry.listeners.get(event).snapshot();
    for (let i = 0; i < ids.length; i++) {
      this.pushEventOnce(owner, deliveredCallbackIds, ids[i], payload);
    }
    if (owner.legacyBoundSocketId === entry.socketId) {
      const legacyPayload = this.legacyPayloadFor(event, payload);
      const legacyIds = owner.legacySlots.get(event).snapshot();
      for (let i = 0; i < legacyIds.length; i++) {
        this.pushEventOnce(owner, deliveredCallbackIds, legacyIds[i], legacyPayload);
      }
    }
  }

  /**
   * 全局 `wx.onSocketOpen` 的结果类型只有 `{ header }`：分段耗时 profile 属于任务态
   * `SocketTask.onOpen` 的结果类型，注册全局监听的小程序不该收到它。message / error /
   * close 三类事件任务态与全局共用同一个结果类型，原样透传。
   *
   * 正常派发与迟到补发两条路都过这里，任何一条漏掉投影都会把 profile 泄漏给全局监听。
   */
  private legacyPayloadFor(event: string, payload: object): object {
    if (event !== 'open') {
      return payload;
    }
    const source = payload as { header?: object };
    return { header: source.header };
  }

  private pushEventOnce(owner: DMPOwnerState, deliveredCallbackIds: string[] | null,
    callbackId: string, payload: object): void {
    if (deliveredCallbackIds) {
      if (deliveredCallbackIds.indexOf(callbackId) !== -1) {
        return;
      }
      deliveredCallbackIds.push(callbackId);
    }
    this.pushEvent(owner, callbackId, payload);
  }

  private recordTerminalEvent(owner: DMPOwnerState, socketId: string, event: string,
    payload: object): DMPTerminalEvent {
    const key = `${socketId}|${event}`;
    owner.terminalReplay.delete(key);
    const record = new DMPTerminalEvent(payload);
    owner.terminalReplay.set(key, record);
    while (owner.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
      const oldest = owner.terminalReplay.keys().next();
      if (oldest.done) {
        break;
      }
      owner.terminalReplay.delete(oldest.value);
    }
    return record;
  }

  /** 新一代同 socketId 连接开始前，移除上一代连接留下的终态补发记录。 */
  private clearTerminalReplay(owner: DMPOwnerState, socketId: string): void {
    owner.terminalReplay.delete(`${socketId}|error`);
    owner.terminalReplay.delete(`${socketId}|close`);
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
