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

  sendCalls: (string | ArrayBuffer)[] = [];
  closeCalls: webSocket.WebSocketCloseOptions[] = [];
  sendShouldSucceed: boolean = true;
  private handlers: Map<string, Function> = new Map<string, Function>();

  connect(url: string, options: webSocket.WebSocketRequestOptions, callback: AsyncCallback<boolean>): void {
    this.connectCalls.push({ url, options });
    callback(null as unknown as BusinessError, true);
  }

  /**
   * 打开后 send 的结果回调会被扣住，由用例决定什么时候回——真实传输层在连接被拆掉之后
   * 还会异步回一次取消结果，这条迟到的路径只能这样构造。
   */
  deferSendCompletions: boolean = false;
  private pendingSendCallbacks: AsyncCallback<boolean>[] = [];

  send(data: string | ArrayBuffer, callback: AsyncCallback<boolean>): void {
    this.sendCalls.push(data);
    if (this.deferSendCompletions) {
      this.pendingSendCallbacks.push(callback);
      return;
    }
    callback(null as unknown as BusinessError, this.sendShouldSucceed);
  }

  /** 按顺序把扣住的 send 结果回调全部放出去。 */
  flushSendCompletions(): void {
    const pending: AsyncCallback<boolean>[] = this.pendingSendCallbacks;
    this.pendingSendCallbacks = [];
    for (const cb of pending) {
      cb(null as unknown as BusinessError, this.sendShouldSucceed);
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

  fireHeaderReceive(key: string, value: string): void {
    const h = this.handlers.get('headerReceive');
    if (h) {
      const headers: any = {};
      headers[key] = value;
      h(headers);
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

export function firstSuccessErrMsg(calls: CallbackRecord[]): string {
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].cbType === DMPBridgeCallbackType.Success) {
      return calls[i].args.get('errMsg');
    }
  }
  return '';
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

export function payloadProfileNumber(payload: object, key: string): number {
  const p: any = payload;
  return p && p.profile ? (p.profile[key] ?? -1) : -1;
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

export function newConnectParams(socketId: string): DMPMap {
  return new DMPMap({ socketId, url: 'wss://example.com/socket' });
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

export function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
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

export class TestSetup {
  manager!: DMPWebSocketManager;
  scheduler!: FakeScheduler;
  createdTransports: FakeTransport[] = [];
  events: CapturedEvent[] = [];
}
