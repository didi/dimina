import { ErrorEvent, MessageEvents, util, worker } from '@kit.ArkTS';
import { DMPAppManager } from '../DApp/DMPAppManager';
import { DMPMap } from '../Utils/DMPMap';
import { DMPApp } from '../DApp/DMPApp';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPChannelProxyNext } from './DMPChannelProxyNext';
import {
  AbPayload,
  canvasError,
  CallerReturnType,
  EvalPayload,
  initPayload,
  Payload,
  PendingRequest,
  WorkerAppData,
  WorkerCanvasRequest,
  WorkerCanvasResult,
  WorkerFlushRequest,
  WorkerFlushResponse,
  WorkerRequest,
  WorkerResponse,
} from './DMPSendableObjects';
import { DMPWorkerCaller } from './DMPWorkerCaller';
import { DMPWorkerFlushBarrier } from './DMPWorkerFlushBarrier';
import common from '@ohos.app.ability.common';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import { DMPVirtualFileConfig } from '../Bundle/Util/DMPFileUrlConvertor';


export class DMPWorkerWrapper {
  w: worker.ThreadWorker;
  appIndex: number;
  debuggerAddress: string;
  runtimeSourceURL: string;
  pendingRequests = new Map<string, PendingRequest>();
  private nextFlushRequestId = 0;
  private destroyed = false;
  private terminationTimer: number | undefined;
  private flushBarrier = new DMPWorkerFlushBarrier();

  constructor(appIndex: number, debuggerAddress: string = '',
    runtimeSourceURL: string = '/__dimina__/unknown/runtime/eval.js') {
    this.appIndex = appIndex;
    this.debuggerAddress = debuggerAddress;
    this.runtimeSourceURL = runtimeSourceURL;

    this.w = new worker.ThreadWorker('./DMPWorker.ets');

    let caller = new DMPWorkerCaller();
    this.w.registerGlobalCallObject("caller", caller);


    // 统一的消息监听器
    this.w.onmessage = (e: MessageEvents): void => {
      // DMPLogger.e(Tags.JS_ENGINE, `DMPWorkerWrapper onmessage`);

      const responseType: string | undefined = (e.data as WorkerResponse).type;
      if (responseType === 'destroyed') {
        this.terminateWorker();
        return;
      }
      if (this.destroyed) return;
      const canvasRequest = e.data as WorkerCanvasRequest;
      if (canvasRequest.type === 'canvasSync') {
        if (Date.now() >= canvasRequest.deadline) {
          this.w.postMessage(new WorkerCanvasResult(canvasRequest.requestId, canvasError('canvas query timed out')));
          return;
        }
        const app = DMPAppManager.sharedInstance().getApp(this.appIndex);
        const reply = app ? app.render.canvasNodeSync(DMPMap.createFromObject(JSON.parse(canvasRequest.body))) :
          Promise.resolve(canvasError('app destroyed'));
        reply.then((result: string) => {
          if (!this.destroyed) this.w.postMessage(new WorkerCanvasResult(canvasRequest.requestId, result));
        });
        return;
      }

      const flushResponse = e.data as WorkerFlushResponse;
      if (flushResponse.type === 'flush') {
        this.flushBarrier.complete(flushResponse.requestId);
        return;
      }

      let response: WorkerResponse = e.data;
      let decoder = util.TextDecoder.create('utf-8');
      let msg = decoder.decodeToString(new Uint8Array(response.ab));
      DMPChannelProxyNext.ServiceToRenderWithAppIndex(msg, response.id, appIndex);
    }

    this.w.onerror = (err: ErrorEvent) => {
      DMPLogger.e(Tags.JS_ENGINE, `ww onerror ${err.message}`);
      this.flushBarrier.markUnavailable();
    }

    this.w.onmessageerror = (err: MessageEvents) => {
      DMPLogger.e(Tags.JS_ENGINE, `ww onmessageerror`);
      this.flushBarrier.markUnavailable();
    }

  }

  // 发送请求的通用函数
  sendRequestToWorker(command: string, payload: Payload) {
    return new Promise<CallerReturnType>((resolve, reject) => {
      let message: WorkerRequest = new WorkerRequest(command, payload);
      this.pendingRequests.set('', { resolve, reject });
      this.w.postMessageWithSharedSendable(message);
    });
  }

  async evalJS(script: string, sourceURL: string) {
    let message: EvalPayload = new EvalPayload('evalJS', script, sourceURL);
    this.w.postMessageWithSharedSendable(message);
  }

  async evalJSByUri(path: string, sourceURL: string) {
    let message: EvalPayload = new EvalPayload('evalJSByUri', path, sourceURL);
    this.w.postMessageWithSharedSendable(message);
  }

  async evalJSAb(ab: ArrayBuffer, sourceURL: string) {
    let message: AbPayload = new AbPayload('evalJSAb', ab, sourceURL);
    this.w.postMessage(message, [ab]);
  }

  /** Resolves after the Worker has processed every command posted before this barrier. */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.nextFlushRequestId++;
      const requestId = this.nextFlushRequestId;
      if (!this.flushBarrier.register(requestId, resolve)) {
        resolve();
        return;
      }
      try {
        this.w.postMessageWithSharedSendable(new WorkerFlushRequest(requestId));
      } catch (error) {
        DMPLogger.e(Tags.JS_ENGINE, `worker flush post failed ${(error as Error).message}`);
        this.flushBarrier.markUnavailable();
      }
    });
  }

  async initEngine(appIndex: number) {
    const context: common.UIAbilityContext = DMPApp.context;
    const isDebugMode: boolean = DMPContextUtils.debugMode;
    let payload = new initPayload(
      'init',
      appIndex,
      context,
      isDebugMode,
      this.debuggerAddress,
      this.runtimeSourceURL,
      DMPVirtualFileConfig.getPrefix()
    );
    this.w.postMessage(payload);
  }

  private terminateWorker() {
    if (this.terminationTimer !== undefined) {
      clearTimeout(this.terminationTimer);
      this.terminationTimer = undefined;
    }
    this.w.terminate();
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Once teardown starts, no Worker ACK can be required to make forward progress.
    this.flushBarrier.markUnavailable();
    this.terminationTimer = setTimeout(() => this.terminateWorker(), 5000);
    let payload = new Payload();
    let message: WorkerRequest = new WorkerRequest('destroy', payload);
    try {
      this.w.postMessageWithSharedSendable(message);
    } catch (error) {
      DMPLogger.e(Tags.JS_ENGINE, `worker destroy post failed ${(error as Error).message}`);
      this.terminateWorker();
    }

    DMPLogger.e(Tags.JS_ENGINE, `worker ${this.appIndex} destroy/terminate`);
  }

  async updateWorkerAppData(appData: WorkerAppData) {
    let payload = new Payload(undefined, undefined, appData);
    let message: WorkerRequest = new WorkerRequest('updateWorkerAppData', payload);
    this.w.postMessageWithSharedSendable(message);
  }
}
