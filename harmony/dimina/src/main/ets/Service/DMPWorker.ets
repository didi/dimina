import { ErrorEvent, MessageEvents, ThreadWorkerGlobalScope, worker } from '@kit.ArkTS';
import { DMPBridgeCallback, DMPBridgeCallbackType, DMPTSUtil } from '../Bridges/DMPTSUtil';
import { DMPWorkerModuleManager } from '../Bridges/DMPWorkerModuleManager';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPJSEngine } from './DMPJSEngine';
import { DMPMap } from '../Utils/DMPMap';
import {
  AbPayload,
  CallerReturnType,
  EvalPayload,
  initPayload,
  WorkerAppData,
  WorkerRequest,
  WorkerResponse
} from './DMPSendableObjects';
import { DMPContextUtils, DMPWorkerContext } from '../Utils/DMPContextUtils';
import { DMPRawFileUtils } from '../Utils/DMPRawFileUtils';


const workerPort: ThreadWorkerGlobalScope = worker.workerPort;
type DMPBridgeParams = DMPMap | number | string | boolean | object;

let appIndex = -1;
let jsEngine: DMPJSEngine = new DMPJSEngine()
let workerModuleManager: DMPWorkerModuleManager;

// t: type invoke / publish
// wid: webviewId
const serviceToContainer = (t: number, wid: number, msg: string, ab: ArrayBuffer): CallerReturnType => {
  // 如果可以在 worker 解决的，就不传递到 main thread
  let result: CallerReturnType;

  if (t === 1) {
    const data: object = JSON.parse(msg);
    const type: string = data['type'];
    const target: string = data['target'];
    const body: object = data['body'];

    if (target === 'container' && type === 'invokeAPI') {
      const methodName: string = body['name'];
      const moduleName = 'DMPContainerBridgesModule';
      let obj = workerModuleManager.getModuleObjectByMethodNameAndModuleName(methodName, moduleName)
      // DMPLogger.d(Tags.JS_ENGINE, `worker methodName: ${methodName}`)

      if (obj) {
        const rawParams: DMPBridgeParams | null | undefined = body['params'];
        let params: DMPBridgeParams = new Object();
        if (rawParams !== undefined && rawParams !== null) {
          params = typeof rawParams === 'object' ? DMPMap.createFromObject(rawParams as Object) : rawParams;
        }
        const callback: DMPBridgeCallback = (args: DMPMap, cbType: DMPBridgeCallbackType) => {
          if (params instanceof DMPMap) {
            let id = ''
            if (cbType == DMPBridgeCallbackType.Success) {
              if (!params.hasKey('success')) {
                return
              }
              id = params.get('success')
            } else if (cbType == DMPBridgeCallbackType.Fail) {
              if (!params.hasKey('fail')) {
                return
              }
              id = params.get('fail')
            } else if (cbType == DMPBridgeCallbackType.Complete) {
              if (!params.hasKey('complete')) {
                return
              }
              id = params.get('complete')
            }

            const msg: DMPMap = new DMPMap({
              type: 'triggerCallback',
              body: {
                id: id,
                args: args?.toObject() ?? new Object()
              }
            })
            // worker 内部闭环 js 调用
            // DMPLogger.d(Tags.JS_ENGINE, `worker before evalJS: ${methodName} ${msg.toStr()}`)
            jsEngine.evalJS(`DiminaServiceBridge.onMessage(${msg.toStr()})`)
          }
        }

        // DMPLogger.d(Tags.JS_ENGINE, `worker before invokeNativeMethod: ${methodName}`)
        return DMPTSUtil.invokeNativeMethod(obj, methodName, params, 0, callback)
      }
    }

    // 如果 worker 线程不执行，侧交给主线程执行
    // DMPLogger.d(Tags.JS_ENGINE, `QuickJS before callGlobalCallObjectMethod: ${msg}`)
    result = workerPort.callGlobalCallObjectMethod("caller", "toContainer", 0, type, body, target, appIndex);
    // DMPLogger.d(Tags.JS_ENGINE, `QuickJS after callGlobalCallObjectMethod, ${result}`)
    return result;

  } else if (t === 2) {
    workerPort.postMessage(new WorkerResponse(wid, ab), [ab]);
    return 0;
  } else if (t === 3) {
    workerPort.postMessage(new WorkerResponse(wid, ab, 'sendLogToContainer'), [ab]);
    return 0;
  }

  return 0;
}


/**
 * Defines the event handler to be called when the worker thread receives a message sent by the host thread.
 * The event handler is executed in the worker thread.
 *
 * @param e message data
 */
workerPort.onmessage = async (e: MessageEvents) => {
  let request: WorkerRequest = e.data;
  // DMPLogger.e(Tags.JS_ENGINE, `worker onmessage ${request.command}`);
  try {
    switch (request.command) {
      case 'init': {
        DMPLogger.d(Tags.LAUNCH, `Worker线程启动 appIndex 初始值: ${appIndex}`);
        // 记录当前是哪个 app 下
        let request: initPayload = e.data as initPayload;
        appIndex = request.appIndex;
        const isDebugMode: boolean = request.isDebugMode
        jsEngine.initWithWorker(appIndex, serviceToContainer,isDebugMode);
        // 提前存储 context，在子线程使用
        const c = DMPWorkerContext.sharedInstance();
        c.context = request.context;

        // DMPLogger.e(Tags.JS_ENGINE, `worker evalJS [dimina][service]`);
        // let context = DMPContextUtils.getUIAbilityContext();
        // let s: string = DMPRawFileUtils.loadFile(context, 'nextTick.js');
        // jsEngine.evalJS(s);
      }
        break;
      case 'evalJS': {
        let request: EvalPayload = e.data as EvalPayload;
        // DMPLogger.e(Tags.JS_ENGINE, `worker evalJS ${request.strVal!}`);
        jsEngine.evalJS(request.strVal);
      }
        break;
      case 'evalJSByUri': {
        let request: EvalPayload = e.data as EvalPayload;
        jsEngine.evalJSPath(request.strVal);
      }
        break;
      case 'evalJSAb': {
        let request: AbPayload = e.data as AbPayload;
        jsEngine.evalJSAb(request.ab);
      }
        break;
      case 'destroy': {
        jsEngine.destroy();
      }
        break;
      case 'updateWorkerAppData': {
        DMPLogger.d(Tags.LAUNCH, "Worker线程创建 WorkerBridge 模块");
        let workerAppData: WorkerAppData = request.payload.appData!;
        if (!workerModuleManager) {
          workerModuleManager = new DMPWorkerModuleManager(workerAppData);
        } else {
          workerModuleManager.app = workerAppData;
        }
      }
        break;
      default:
        break;
    }

  } catch (err) {
    const error: string = err.message;
    DMPLogger.e(Tags.JS_ENGINE, `worker error ${error}`);
  }
}

/**
 * Defines the event handler to be called when the worker receives a message that cannot be deserialized.
 * The event handler is executed in the worker thread.
 *
 * @param e message data
 */
workerPort.onmessageerror = (e: MessageEvents) => {
  DMPLogger.e(Tags.JS_ENGINE, `worker onmessageerror`);
}

/**
 * Defines the event handler to be called when an exception occurs during worker execution.
 * The event handler is executed in the worker thread.
 *
 * @param e error message
 */
workerPort.onerror = (e: ErrorEvent) => {
  DMPLogger.e(Tags.JS_ENGINE, `worker onerror`);
}
