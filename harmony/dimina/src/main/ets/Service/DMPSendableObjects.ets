// 因为 worker 线程不能直接使用 app 对象，这个类作用是用于更新数据
import { DMPMap } from '../Utils/DMPMap';
import { util } from '@kit.ArkTS';
import common from '@ohos.app.ability.common';

// 这个是传递用
@Sendable
export class WorkerAppData {
  appIndex: number = -1;
  appId: string = '';
  jsAppVersion: string = '';
}

// 这个是 Worker 使用，之所以要用两个，是因为 Sendable 在有些类里面不能成为成员变量
export class AppData {
  appIndex: number = -1;
  appId: string = '';
  jsAppVersion: string = '';
}

@Sendable
export class Payload {
  // init 使用
  appIndex?: number;
  // evalJS 使用
  script?: string;
  // updateAppData 使用
  appData?: WorkerAppData;

  constructor(appIndex?: number, script?: string, appData?: WorkerAppData) {
    this.appIndex = appIndex;
    this.script = script;
    this.appData = appData;
  }
}


export class AbPayload {
  command: string;
  ab: ArrayBuffer;
  sourceURL: string;

  constructor(command: string, ab: ArrayBuffer, sourceURL: string) {
    this.command = command;
    this.ab = ab;
    this.sourceURL = sourceURL;
  }
}

@Sendable
export class EvalPayload {
  command: string;
  strVal: string;
  sourceURL: string;

  constructor(command: string, strVal: string, sourceURL: string) {
    this.command = command;
    this.strVal = strVal;
    this.sourceURL = sourceURL;
  }
}

// 初始化引擎用的数据结构
export class initPayload {
  command: string;
  context: common.UIAbilityContext;
  appIndex: number;
  isDebugMode: boolean;
  debuggerAddress: string;
  runtimeSourceURL: string;

  constructor(command: string, appIndex: number, context: common.UIAbilityContext, isDebugMode: boolean,
    debuggerAddress: string, runtimeSourceURL: string) {
    this.command = command;
    this.appIndex = appIndex;
    this.context = context;
    this.isDebugMode = isDebugMode;
    this.debuggerAddress = debuggerAddress;
    this.runtimeSourceURL = runtimeSourceURL;
  }
}


// @Sendable 不支持下面这种类型定义，编译能通过，但是会在运行时报错
export type WorkerMessageType = number | string | boolean;

export type CallerReturnType = DMPMap | number | string | boolean | object;

@Sendable
export class WorkerRequest {
  command: string;
  payload: Payload;

  constructor(command: string, payload: Payload) {
    this.command = command;
    this.payload = payload;
  }
}

@Sendable
export class WorkerFlushRequest {
  command: string = 'flush';
  requestId: number;

  constructor(requestId: number) {
    this.requestId = requestId;
  }
}

@Sendable
export class WorkerFlushResponse {
  type: string = 'flush';
  requestId: number;

  constructor(requestId: number) {
    this.requestId = requestId;
  }
}


@Sendable
export class WorkerAppDataRequest {
  id: string;
  command: string;
  payload?: WorkerMessageType;

  constructor(id: string, command: string, payload?: WorkerMessageType) {
    this.id = id;
    this.command = command;
    this.payload = payload;
  }
}


export class WorkerResponse {
  id: number;
  ab: ArrayBuffer;
  type?: string;

  constructor(id: number, ab: ArrayBuffer, type?: string) {
    this.id = id;
    this.ab = ab;
    this.type = type;
  }
}

export interface WorkerCallback {
  result?: WorkerMessageType;
}

export interface PendingRequest {
  resolve: (value: WorkerMessageType) => void;
  reject: (reason?: string) => void;
}
