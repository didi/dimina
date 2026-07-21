import { ErrorEvent, MessageEvents, util, worker } from '@kit.ArkTS';
import { DMPApp } from '../DApp/DMPApp';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPChannelProxyNext } from './DMPChannelProxyNext';
import {
  AbPayload,
  CallerReturnType,
  EvalPayload,
  initPayload,
  Payload,
  PendingRequest,
  WorkerAppData,
  WorkerRequest,
  WorkerResponse,
} from './DMPSendableObjects';
import { DMPWorkerCaller } from './DMPWorkerCaller';
import common from '@ohos.app.ability.common';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import diminaNative from 'libdimina.so';
import { DMPCanvasManager, CanvasFlushParams } from '../Render/SameLayer/DMPCanvasManager';

interface CanvasSyncOpParams {
  name: string
}

export class DMPWorkerWrapper {
  w: worker.ThreadWorker;
  appIndex: number;
  pendingRequests = new Map<string, PendingRequest>();

  constructor(appIndex: number) {
    this.appIndex = appIndex;

    this.w = new worker.ThreadWorker('./DMPWorker.ets');

    let caller = new DMPWorkerCaller();
    this.w.registerGlobalCallObject("caller", caller);

    // Register canvas TSFN for direct QuickJS → main-thread communication
    diminaNative.registerCanvasTsfn(appIndex, (type: number, data: string): string => {
      DMPLogger.i(Tags.JS_ENGINE, `canvasTsfn callback: type=${type} dataLen=${data.length} appIndex=${appIndex}`)
      const mgr = DMPCanvasManager.sharedInstance()
      if (type === 1) {
        // Async flush
        const params = JSON.parse(data) as CanvasFlushParams
        DMPLogger.i(Tags.JS_ENGINE, `canvasTsfn flush: nodeId=${params.nodeId} ops=${params.operations?.length}`)
        mgr.handleNativeFlush(params, appIndex)
        return ''
      }
      // Sync ops: dispatch by the op name carried in params
      // (the numeric type is only meaningful for flush=1)
      const params: Object = JSON.parse(data) as Object
      const name = (params as CanvasSyncOpParams).name
      if (name === 'canvasGetImageData') {
        return JSON.stringify(mgr.handleGetImageData(params, 0, appIndex))
      } else if (name === 'canvasToDataURLSync') {
        return JSON.stringify(mgr.handleToDataURLSync(params, 0, appIndex))
      } else if (name === 'canvasMeasureText') {
        return JSON.stringify(mgr.handleMeasureText(params, appIndex))
      } else if (name === 'canvasIsPointInPath') {
        return JSON.stringify(mgr.handleIsPointInPath(params, appIndex, false))
      } else if (name === 'canvasIsPointInStroke') {
        return JSON.stringify(mgr.handleIsPointInPath(params, appIndex, true))
      }
      DMPLogger.e(Tags.JS_ENGINE, `canvasTsfn: unknown sync op name=${name} type=${type}`)
      return '{}'
    })

    // 统一的消息监听器
    this.w.onmessage = (e: MessageEvents): void => {
      // DMPLogger.e(Tags.JS_ENGINE, `DMPWorkerWrapper onmessage`);

      let response: WorkerResponse = e.data;
      let decoder = util.TextDecoder.create('utf-8');
      let msg = decoder.decodeToString(new Uint8Array(response.ab));
      DMPChannelProxyNext.ServiceToRenderWithAppIndex(msg, response.id, appIndex);
    }

    this.w.onerror = (err: ErrorEvent) => {
      DMPLogger.e(Tags.JS_ENGINE, `ww onerror ${err.message}`);
    }

    this.w.onmessageerror = (err: MessageEvents) => {
      DMPLogger.e(Tags.JS_ENGINE, `ww onmessageerror`);
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

  async evalJS(script: string) {
    let message: EvalPayload = new EvalPayload('evalJS', script);
    this.w.postMessageWithSharedSendable(message);
  }

  async evalJSByUri(path: string) {
    let message: EvalPayload = new EvalPayload('evalJSByUri', path);
    this.w.postMessageWithSharedSendable(message);
  }

  async evalJSAb(ab: ArrayBuffer) {
    let message: AbPayload = new AbPayload('evalJSAb', ab);
    this.w.postMessage(message, [ab]);
  }

  async initEngine(appIndex: number) {
    const context: common.UIAbilityContext = DMPApp.context;
    const isDebugMode: boolean = DMPContextUtils.debugMode;
    let payload = new initPayload('init', appIndex, context, isDebugMode);
    this.w.postMessage(payload);
  }

  async destroy() {
    let payload = new Payload();
    let message: WorkerRequest = new WorkerRequest('destroy', payload);
    this.w.postMessageWithSharedSendable(message);

    DMPLogger.e(Tags.JS_ENGINE, `worker ${this.appIndex} destroy/terminate`);
    this.w.terminate();
  }

  async updateWorkerAppData(appData: WorkerAppData) {
    let payload = new Payload(undefined, undefined, appData);
    let message: WorkerRequest = new WorkerRequest('updateWorkerAppData', payload);
    this.w.postMessageWithSharedSendable(message);
  }
}

