/**
 * DMPWebSocketManagerTest 的测试基础设施（fake 传输/时钟、回调捕获、payload 读取）。
 *
 * 刻意写成 .ts（不是 .ets）：ArkTS 静态检查（arkts-no-obj-literals-as-types /
 * arkts-no-indexed-signatures / arkts-no-any-unknown / arkts-no-nested-funcs 等）
 * 会拒绝这里大量使用的内联对象字面量类型、索引签名、any 断言与嵌套 function 声明。
 * .ets 单测文件只导入并调用这里导出的类型化函数/类（.ets 允许导入 .ts，反向禁止）。
 */
import { webSocket } from '@kit.NetworkKit';
import { AsyncCallback, BusinessError, Callback, ErrorCallback } from '@kit.BasicServicesKit';
import {
  DMPSocketTransport,
  DMPTimerScheduler,
  DMPWebSocketManager,
} from '../main/ets/Bridges/Network/DMPWebSocketManager';
import { DMPBridgeCallback, DMPBridgeCallbackType } from '../main/ets/Bridges/DMPTSUtil';
import { DMPMap } from '../main/ets/Utils/DMPMap';

export class FakeTransport implements DMPSocketTransport {
  connectCalls: any[] = [];
  /** 第一次拨号时下发的某个请求头，取不到返回 ''。 */
  dialedHeader(name: string): string {
    const call = this.connectCalls[0];
    if (!call) {
      return '';
    }
    const header = call.options?.header as Record<string, string> | undefined;
    return header && header[name] ? header[name] : '';
  }

  /** 第一次拨号时下发的完整请求头字段名集合（原样大小写），没有拨号返回空数组。 */
  dialedHeaderKeys(): string[] {
    const call = this.connectCalls[0];
    if (!call) {
      return [];
    }
    const header = call.options?.header as Record<string, string> | undefined;
    return header ? Object.keys(header) : [];
  }

  /** 第 n 次拨号用的 url，取不到返回 ''。 */
  dialedUrl(index: number): string {
    const call = this.connectCalls[index];
    return call ? (call.url as string) : '';
  }

  sendCalls: (string | ArrayBuffer)[] = [];
  closeCalls: webSocket.WebSocketCloseOptions[] = [];
  sendShouldSucceed: boolean = true;
  private handlers: Map<string, Function> = new Map<string, Function>();
  /** Handlers removed by manager teardown, retained only so tests can model callbacks already queued by the SDK. */
  private detachedHandlers: Map<string, Function> = new Map<string, Function>();

  /**
   * 非空时，`connect()` 的结果回调带这个错误回来，模拟传输层当场拒绝拨号（区别于拨号
   * 受理之后才通过 `on('error')` 报失败）。
   */
  connectError: BusinessError | null = null;

  connect(url: string, options: webSocket.WebSocketRequestOptions, callback: AsyncCallback<boolean>): void {
    this.connectCalls.push({ url, options });
    const err = this.connectError;
    callback(err ?? (null as unknown as BusinessError), err === null);
  }

  /**
   * 打开后 send 的结果回调会被扣住，由用例决定什么时候回——真实传输层在连接被拆掉之后
   * 还会异步回一次取消结果，这条迟到的路径只能这样构造。
   */
  deferSendCompletions: boolean = false;
  private pendingSendCallbacks: AsyncCallback<boolean>[] = [];

  /**
   * 非空时，send 的结果回调带一个这条消息的 BusinessError 回来，模拟传输层自己拒绝这次
   * 发送（区别于 sendShouldSucceed=false 的「回了结果但结果是失败」）。
   */
  sendErrorMessage: string = '';

  private sendCallbackError(): BusinessError {
    return this.sendErrorMessage
      ? (new Error(this.sendErrorMessage) as BusinessError)
      : (null as unknown as BusinessError);
  }

  send(data: string | ArrayBuffer, callback: AsyncCallback<boolean>): void {
    this.sendCalls.push(data);
    if (this.deferSendCompletions) {
      this.pendingSendCallbacks.push(callback);
      return;
    }
    callback(this.sendCallbackError(), this.sendShouldSucceed);
  }

  /** 按顺序把扣住的 send 结果回调全部放出去。 */
  flushSendCompletions(): void {
    const pending: AsyncCallback<boolean>[] = this.pendingSendCallbacks;
    this.pendingSendCallbacks = [];
    for (const cb of pending) {
      cb(this.sendCallbackError(), this.sendShouldSucceed);
    }
  }

  close(options: webSocket.WebSocketCloseOptions, callback: AsyncCallback<boolean>): void {
    this.closeCalls.push(options);
    callback(null as unknown as BusinessError, true);
  }

  on(type: 'open', callback: AsyncCallback<Object>): void;
  on(type: 'message', callback: AsyncCallback<string | ArrayBuffer>): void;
  on(type: 'close', callback: AsyncCallback<webSocket.CloseResult>): void;
  on(type: 'error', callback: ErrorCallback): void;
  on(type: 'headerReceive', callback: Callback<webSocket.ResponseHeaders>): void;
  on(type: string, callback: Function): void {
    this.handlers.set(type, callback);
  }

  off(type: 'open'): void;
  off(type: 'message'): void;
  off(type: 'close'): void;
  off(type: 'error'): void;
  off(type: 'headerReceive'): void;
  off(type: string): void {
    const handler = this.handlers.get(type);
    if (handler) {
      this.detachedHandlers.set(type, handler);
    }
    this.handlers.delete(type);
  }

  fireOpen(): void {
    const h = this.handlers.get('open');
    if (h) {
      h(null, {});
    }
  }

  fireMessage(data: string | ArrayBuffer): void {
    const h = this.handlers.get('message');
    if (h) {
      h(null, data);
    }
  }

  fireClose(code: number, reason: string): void {
    const h = this.handlers.get('close');
    if (h) {
      h(null, { code, reason });
    }
  }

  fireError(message: string): void {
    const h = this.handlers.get('error');
    if (h) {
      const err = new Error(message) as BusinessError;
      h(err);
    }
  }

  /**
   * open / message / close 三个回调的第一个参数都是 BusinessError，带错时第二个参数可能是
   * undefined。这三个入口让用例走到那条路径上——只用 `fireOpen`/`fireMessage`/`fireClose`
   * 的话第一个参数永远是 null，容器里那三处判错的分支一条都到不了。
   */
  fireOpenError(message: string): void {
    const h = this.handlers.get('open');
    if (h) {
      h(new Error(message) as BusinessError, undefined);
    }
  }

  fireMessageError(message: string): void {
    const h = this.handlers.get('message');
    if (h) {
      h(new Error(message) as BusinessError, undefined);
    }
  }

  fireCloseError(message: string): void {
    const h = this.handlers.get('close');
    if (h) {
      h(new Error(message) as BusinessError, undefined);
    }
  }

  /**
   * 带结构化错误码的传输层错误。分类只看 `code`，不看消息文本，所以用例要能把两者
   * 独立地喂进去（同一段文本配不同的码、同一个码配不同语言的文本）。
   */
  fireErrorWithCode(code: number, message: string): void {
    const h = this.handlers.get('error');
    if (h) {
      const err = new Error(message) as BusinessError;
      err.code = code;
      h(err);
    }
  }

  /** 同一个响应头以字符串数组形式到达（`ResponseHeaders` 的值类型是 `string | string[]`）。 */
  fireHeaderReceiveList(key: string, values: string[]): void {
    const h = this.handlers.get('headerReceive');
    if (h) {
      const headers: any = {};
      headers[key] = values;
      h(headers);
    }
  }

  fireHeaderReceive(key: string, value: string): void {
    const h = this.handlers.get('headerReceive');
    if (h) {
      const headers: any = {};
      headers[key] = value;
      h(headers);
    }
  }

  fireDetachedOpen(): void {
    this.detachedHandlers.get('open')?.(null, {});
  }

  fireDetachedMessage(data: string | ArrayBuffer): void {
    this.detachedHandlers.get('message')?.(null, data);
  }

  fireDetachedClose(code: number, reason: string): void {
    this.detachedHandlers.get('close')?.(null, { code, reason });
  }

  fireDetachedError(message: string): void {
    const handler = this.detachedHandlers.get('error');
    if (handler) {
      handler(new Error(message) as BusinessError);
    }
  }

  fireDetachedHeaderReceive(key: string, value: string): void {
    const handler = this.detachedHandlers.get('headerReceive');
    if (handler) {
      const headers: any = {};
      headers[key] = value;
      handler(headers);
    }
  }
}

class FakeTask {
  fn: () => void = () => {
  };
  at: number = 0;
}

export class FakeScheduler implements DMPTimerScheduler {
  private nextHandle: number = 1;
  private tasks: Map<number, FakeTask> = new Map<number, FakeTask>();
  private currentTime: number = 0;

  schedule(fn: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    const task = new FakeTask();
    task.fn = fn;
    task.at = this.currentTime + delayMs;
    this.tasks.set(handle, task);
    return handle;
  }

  cancel(handle: number): void {
    this.tasks.delete(handle);
  }

  now(): number {
    return this.currentTime;
  }

  /** 手动推进时钟并触发所有到期任务（含任务内新排的任务，直到没有更多到期任务为止） */
  advance(ms: number): void {
    this.currentTime += ms;
    let firedSomething = true;
    while (firedSomething) {
      firedSomething = false;
      const dueHandles: number[] = [];
      this.tasks.forEach((task, handle) => {
        if (task.at <= this.currentTime) {
          dueHandles.push(handle);
        }
      });
      for (let i = 0; i < dueHandles.length; i++) {
        const handle = dueHandles[i];
        const task = this.tasks.get(handle);
        if (!task) {
          continue;
        }
        this.tasks.delete(handle);
        firedSomething = true;
        task.fn();
      }
    }
  }
}

export class CapturedEvent {
  appIndex: number = -1;
  callbackId: string = '';
  payload: object = {};
}

export class CallbackRecord {
  args: DMPMap = new DMPMap();
  cbType: DMPBridgeCallbackType = DMPBridgeCallbackType.Success;
}

export class CapturedCallback {
  calls: CallbackRecord[] = [];
  fn: DMPBridgeCallback = () => {
  };
}

export function captureCallback(): CapturedCallback {
  const result = new CapturedCallback();
  result.fn = (args: DMPMap, cbType: DMPBridgeCallbackType) => {
    const rec = new CallbackRecord();
    rec.args = args;
    rec.cbType = cbType;
    result.calls.push(rec);
  };
  return result;
}

export function firstFailMessage(calls: CallbackRecord[]): string {
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === DMPBridgeCallbackType.Fail) {
      // errMsg 直接放在顶层（与 firstSuccessErrMsg 一致），不再套一层 {data:{errMsg}}——
      // 旧的嵌套读法只是在跟生产代码的（真实）bug 自洽，实际 JS 侧 callback.invoke()
      // 不会解包 data，见 DMPWebSocketManager.ts 的 invokeFail 注释。
      return calls[i].args.get('errMsg') ?? '';
    }
  }
  return '';
}

/** complete 那一次收到的 errMsg；没收到 complete 或载荷里没有 errMsg 都返回空串。 */
export function firstCompleteErrMsg(calls: CallbackRecord[]): string {
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === DMPBridgeCallbackType.Complete) {
      return calls[i].args.get('errMsg') ?? '';
    }
  }
  return '';
}

export function firstSuccessErrMsg(calls: CallbackRecord[]): string {
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === DMPBridgeCallbackType.Success) {
      return calls[i].args.get('errMsg');
    }
  }
  return '';
}

/**
 * 一次回调载荷的规范化序列化，键按字典序排。用来整对象比对——只抽 `errMsg` 比的话，
 * 载荷里多出一个内部字段（socketId 之类）不会被发现，而「complete 与 success 拿到同一个
 * 结果对象」这条契约管的正是整个对象。
 */
function stableValue(value: any): string {
  // `undefined` 与 `null` 分开标记：JSON 把两者都写成 null，`{x: undefined}` 与 `{x: null}`
  // 会得到同一个串，比对就成了假绿。
  if (value === undefined) {
    return '<undefined>';
  }
  if (value === null) {
    return '<null>';
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    const arr = value as any[];
    for (let i = 0; i < arr.length; i++) {
      items.push(stableValue(arr[i]));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    return stableObject(value as Record<string, any>);
  }
  return JSON.stringify(value);
}

/** 逐层按键排序，免得两个内容相同、只是键插入顺序不同的载荷比出「不相等」。 */
function stableObject(obj: Record<string, any>): string {
  const keys: string[] = Object.keys(obj).sort();
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    parts.push(`${JSON.stringify(keys[i])}:${stableValue(obj[keys[i]])}`);
  }
  return `{${parts.join(',')}}`;
}

function stableJson(map: DMPMap): string {
  return stableObject(map.toJSON() as Record<string, any>);
}

function firstPayloadJson(calls: CallbackRecord[], cbType: DMPBridgeCallbackType): string {
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === cbType) {
      return stableJson(calls[i].args);
    }
  }
  return '';
}

/** success 那一次收到的完整载荷；没收到 success 返回空串。 */
export function firstSuccessPayloadJson(calls: CallbackRecord[]): string {
  return firstPayloadJson(calls, DMPBridgeCallbackType.Success);
}

/** fail 那一次收到的完整载荷；没收到 fail 返回空串。 */
export function firstFailPayloadJson(calls: CallbackRecord[]): string {
  return firstPayloadJson(calls, DMPBridgeCallbackType.Fail);
}

/** complete 那一次收到的完整载荷；没收到 complete 返回空串。 */
export function firstCompletePayloadJson(calls: CallbackRecord[]): string {
  return firstPayloadJson(calls, DMPBridgeCallbackType.Complete);
}

function countCallsOfType(calls: CallbackRecord[], cbType: DMPBridgeCallbackType): number {
  let n = 0;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === cbType) {
      n++;
    }
  }
  return n;
}

/**
 * fail 被调用的次数。`firstFailMessage(...) === ''` 分不清「没有 fail」与「有 fail 但载荷是空的」，
 * 要证明某条路径没有失败得数次数。
 */
export function countFailCalls(calls: CallbackRecord[]): number {
  return countCallsOfType(calls, DMPBridgeCallbackType.Fail);
}

/** success 被调用的次数。 */
export function countSuccessCalls(calls: CallbackRecord[]): number {
  return countCallsOfType(calls, DMPBridgeCallbackType.Success);
}

export function findEventByCallbackId(events: CapturedEvent[], callbackId: string): CapturedEvent | undefined {
  for (let i = 0; i < events.length; i++) {
    if (events[i].callbackId === callbackId) {
      return events[i];
    }
  }
  return undefined;
}

export function countEventsByCallbackId(events: CapturedEvent[], callbackId: string): number {
  let count = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].callbackId === callbackId) {
      count++;
    }
  }
  return count;
}

/** payload 字段读取（payload 运行时是普通 object，这里统一做无类型访问，供 .ets 侧按原始类型消费） */
export function payloadHeaderValue(payload: object, key: string): string {
  const p: any = payload;
  return p && p.header ? (p.header[key] ?? '') : '';
}

export function payloadMessageData(payload: object): string {
  const p: any = payload;
  return p ? (p.data ?? '') : '';
}

export function payloadMessageIsBuffer(payload: object): boolean {
  const p: any = payload;
  return !!(p && p.isBuffer === true);
}

export function payloadCloseCode(payload: object): number {
  const p: any = payload;
  return p ? (p.code ?? -1) : -1;
}

export function payloadCloseReason(payload: object): string {
  const p: any = payload;
  return p ? (p.reason ?? '') : '';
}

export function payloadErrMsg(payload: object): string {
  const p: any = payload;
  return p ? (p.errMsg ?? '') : '';
}

/** 载荷的顶层字段名，排序后逗号连接——用来逐字锁定字段全集（多一个少一个都不等）。 */
export function payloadKeys(payload: object): string {
  return payload ? Object.keys(payload).sort().join(',') : '';
}

export function newConnectParams(socketId: string): DMPMap {
  return new DMPMap({ socketId, url: 'wss://example.com/socket' });
}

export function newConnectParamsWithUrl(socketId: string, url: string): DMPMap {
  return new DMPMap({ socketId, url });
}

export function newConnectParamsWithTimeout(socketId: string, timeout: number): DMPMap {
  return new DMPMap({ socketId, url: 'wss://example.com/socket', timeout });
}

export function newConnectParamsWithHeader(socketId: string, headerName: string, headerValue: string): DMPMap {
  const header: Record<string, string> = {};
  header[headerName] = headerValue;
  return new DMPMap({ socketId, url: 'wss://example.com/socket', header });
}

export function newConnectParamsWithHeaders(socketId: string, header: Record<string, string>): DMPMap {
  return new DMPMap({ socketId, url: 'wss://example.com/socket', header });
}

export function newTaskEventParams(socketId: string, callbackId: string): DMPMap {
  return new DMPMap({ socketId, callback: callbackId });
}

export function newLegacyEventParams(callbackId: string): DMPMap {
  return new DMPMap({ callback: callbackId });
}

export function newSocketIdParams(socketId: string): DMPMap {
  return new DMPMap({ socketId });
}

export function newSendParams(socketId: string, data: string): DMPMap {
  return new DMPMap({ socketId, data });
}

export function newBinarySendParams(socketId: string, data: string): DMPMap {
  return new DMPMap({ socketId, data, isBuffer: true });
}

export function newSocketIdCodeParams(socketId: string, code: number): DMPMap {
  return new DMPMap({ socketId, code });
}

export function newSocketIdCodeReasonParams(socketId: string, code: number, reason: string): DMPMap {
  return new DMPMap({ socketId, code, reason });
}

/** Legacy-mode close params (no `socketId` key at all) carrying just a `code`. */
export function newLegacyCodeParams(code: number): DMPMap {
  return new DMPMap({ code });
}

export function newLegacySendParams(data: string): DMPMap {
  return new DMPMap({ data });
}

export function newEmptyParams(): DMPMap {
  return new DMPMap({});
}

/** 拨号通过真实 Promise 微任务排队（同 tick 取消窗口），不经过 FakeScheduler，
 *  调用方需要 `await flushMicrotasks()` 才能让 dial() 真正执行、createdTransports 才会被填充。*/
export function connectAndCapture(manager: DMPWebSocketManager, appId: string, appIndex: number,
  socketId: string): CallbackRecord[] {
  const cap = captureCallback();
  manager.connectSocket(appId, appIndex, '0', newConnectParams(socketId), cap.fn);
  return cap.calls;
}

export function connectWithParams(manager: DMPWebSocketManager, appId: string, appIndex: number,
  params: DMPMap): CallbackRecord[] {
  const cap = captureCallback();
  manager.connectSocket(appId, appIndex, '0', params, cap.fn);
  return cap.calls;
}

export function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

/**
 * 依次拨号并让每条连接都收到 open 事件，返回它们的传输层。并发名额只由已 OPEN 的连接
 * 占用，所以「占满名额」的前置条件必须真的把连接开起来，光拨号不算。
 */
export async function openConnections(setup: TestSetup, appId: string,
  socketIds: string[]): Promise<FakeTransport[]> {
  const opened: FakeTransport[] = [];
  for (const socketId of socketIds) {
    connectAndCapture(setup.manager, appId, 1, socketId);
    await flushMicrotasks();
    const transport = setup.createdTransports[setup.createdTransports.length - 1];
    transport.fireOpen();
    opened.push(transport);
  }
  return opened;
}

/**
 * 登记这个小程序 app.json 里 `networkTimeout.connectSocket` 的毫秒值，`null` 表示没配这一项。
 * 连接超时的优先级是 调用方 `timeout` > 这里 > 60000。
 *
 * 契约要求 Manager 提供 `updateNetworkTimeout(appId: string, connectSocketMs: number | null): void`
 * （与 Android `WebSocketManager.updateNetworkTimeout` 同形状）。这里用动态调用而不是直接
 * 调方法：方法还没接线时 ArkTS 会判整个测试模块编译失败，全套用例一条都跑不起来，
 * 看不出是哪一条在红。改成运行时检查后，缺接线只让这几条用例带着确切原因失败。
 */
export function updateNetworkTimeout(manager: DMPWebSocketManager, appId: string,
  connectSocketMs: number | null): void {
  const dynamic: any = manager;
  if (typeof dynamic.updateNetworkTimeout !== 'function') {
    throw new Error(
      'DMPWebSocketManager.updateNetworkTimeout(appId: string, connectSocketMs: number | null) is not wired');
  }
  dynamic.updateNetworkTimeout(appId, connectSocketMs);
}

export function makeTestSetup(): TestSetup {
  const setup = new TestSetup();
  setup.manager = DMPWebSocketManager.sharedInstance();
  setup.manager.resetAllForTest();
  setup.scheduler = new FakeScheduler();
  setup.createdTransports = [];
  setup.events = [];
  setup.manager.setSchedulerForTest(setup.scheduler);
  setup.manager.setTransportFactoryForTest(() => {
    const t = new FakeTransport();
    t.connectError = setup.pendingConnectError;
    setup.createdTransports.push(t);
    return t;
  });
  setup.manager.setEventSinkForTest((appIndex: number, callbackId: string, payload: object) => {
    const e = new CapturedEvent();
    e.appIndex = appIndex;
    e.callbackId = callbackId;
    e.payload = payload;
    setup.events.push(e);
  });
  return setup;
}

export function teardownTestSetup(setup: TestSetup): void {
  setup.manager.setEventSinkForTest(null);
  setup.manager.resetTransportFactoryForTest();
  setup.manager.resetSchedulerForTest();
  setup.manager.resetAllForTest();
}

/** 传输层错误对象，省得每个用例文件都去 import `@ohos.base` 的 BusinessError 类型。 */
export function newTransportError(message: string): BusinessError {
  return new Error(message) as BusinessError;
}

export class TestSetup {
  manager!: DMPWebSocketManager;
  scheduler!: FakeScheduler;
  createdTransports: FakeTransport[] = [];
  events: CapturedEvent[] = [];
  /**
   * 下一条被造出来的传输的 `connectError`。拨号发生在工厂返回的当场，用例拿不到实例再去
   * 设值，只能在造之前先放在这里。
   */
  pendingConnectError: BusinessError | null = null;
}
