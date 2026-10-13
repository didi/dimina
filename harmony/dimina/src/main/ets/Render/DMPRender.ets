import { canvasError } from '../Service/DMPSendableObjects';
import { DMPApp } from '../DApp/DMPApp';
import { DMPWebViewController } from '../HybridContainer/DMPWebViewController';
import { AsyncCallback } from '@kit.BasicServicesKit';
import { DMPMap } from '../Utils/DMPMap';
import { BusinessError } from '@ohos.base';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { canvasUiRegister, canvasUiUnregister, canvasUiPublish, canvasUiComplete } from 'libdimina.so';

class CanvasUiScope {
  controller: DMPWebViewController;
  generation: number;
  token: string = '';
  closed: boolean = false;
  constructor(controller: DMPWebViewController, generation: number) {
    this.controller = controller; this.generation = generation;
  }
}

export class DMPRender {
  controllerMap: Map<number, DMPWebViewController> = new Map()
  private canvasUiScopes: Map<number, CanvasUiScope> = new Map();
  private canvasGenerations: Map<number, number> = new Map();
  private pendingScripts: Map<number, string[]> = new Map()
  private readonly maxPendingScriptCount: number = 200
  app: DMPApp;

  constructor(app: DMPApp) {
    this.app = app
    // 在 Web 组件初始化之前，通过此接口加载 Web 引擎的动态库文件，以提高启动性能。
    // web_webview.WebviewController.initializeWebEngine()
  }


  executeScript(script: string, webViewId: number, callback?: AsyncCallback<string>) {
    const controller = this.controllerMap.get(webViewId)
    if (controller) {
      if (!controller.isControllerAttached) {
        this.enqueueScript(webViewId, script)
        return
      }
      if (this.canvasUiScopes.has(webViewId)) {
        try {
          if (!canvasUiPublish(this.app.appIndex, webViewId, script))
            DMPLogger.e('', 'canvas UI channel is unavailable');
        } catch (error) { DMPLogger.e('', `canvas UI script failed: ${(error as Error).message}`); }
        return;
      }
      try {
        controller.runJavaScript(script, (error, result) => {
          if (error) {
            DMPLogger.e('', `run JavaScript error: ` + JSON.stringify(error))
            return;
          }
        });
      } catch (error) {
        const businessError = error as BusinessError
        if (businessError?.code === 17100001) {
          controller.isControllerAttached = false
          this.enqueueScript(webViewId, script)
          return
        }
        DMPLogger.e('', `run JavaScript exception: ` + JSON.stringify(error))
      }
    }
  }

  public canvasNodeSync(body: DMPMap, callerDeadline?: number): Promise<string> {
    const webViewId: number = body.get('bridgeId');
    const controller = this.controllerMap.get(webViewId);
    const generation = this.canvasGenerations.get(webViewId) ?? 0;
    if (!controller?.isControllerAttached) {
      return Promise.resolve(canvasError('canvas page is unavailable'));
    }
    const deadline = Math.min(callerDeadline === undefined ? Date.now() + 4500 : callerDeadline, Date.now() + 4500);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return Promise.resolve(canvasError('canvas query timed out'));
    const script = `(() => { try { if (Date.now() >= ${deadline}) throw new Error('canvas query timed out'); if (typeof globalThis.__diminaCanvasSync !== 'function') throw new Error('canvas runtime unavailable'); return JSON.stringify(globalThis.__diminaCanvasSync(${body.toStr()})); } catch (e) { return JSON.stringify({error:String(e)}); } })()`;
    return new Promise<string>((resolve) => {
      let finished = false;
      const complete = (result: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout((): void => {
        complete(canvasError('canvas query timed out'));
      }, Math.max(1, deadline - Date.now()));
      try {
        // Earlier publish messages arrive through this same Worker FIFO and were
        // submitted to this controller before the query.
        controller.runJavaScript(script, (error, result) => {
          if (finished) return;
          if (error) complete(canvasError(error.message));
          else if (this.controllerMap.get(webViewId) !== controller || !controller.isControllerAttached ||
            (this.canvasGenerations.get(webViewId) ?? 0) !== generation)
            complete(canvasError('canvas page was closed'));
          else {
            try {
              // ArkWeb versions may quote a returned JS string in JSON. Accept
              // either wire form, but never silently turn null into feedback.
              const parsed: Object | string | null = JSON.parse(result);
              const json = typeof parsed === 'string' ? parsed : result;
              const feedback: Object | null = JSON.parse(json);
              if (!feedback || typeof feedback !== 'object') throw new Error('invalid canvas feedback');
              const record = feedback as Record<string, Object>;
              if (record['contexts'] && Array.isArray(record['typedArrays']))
                this.bindCanvasUi(webViewId, controller, generation);
              complete(json);
            } catch (error) { complete(canvasError((error as Error).message)); }
          }
        });
      } catch (error) { complete(canvasError((error as Error).message)); }
    });
  }

  private bindCanvasUi(webViewId: number, controller: DMPWebViewController, generation: number): void {
    if (this.canvasUiScopes.has(webViewId)) return;
    const scope = new CanvasUiScope(controller, generation);
    try {
      // Activation happens after the first real query's FIFO barrier. Earlier
      // Worker messages have already been submitted before this callback.
      scope.token = canvasUiRegister(this.app.appIndex, webViewId, (requestId: string, script: string): void => {
        if (!this.isCanvasUiCurrent(webViewId, scope)) {
          if (requestId) canvasUiComplete(requestId, '', 'canvas page was closed');
          return;
        }
        try {
          controller.runJavaScript(script, (error, result) => {
            if (!requestId) return;
            if (!this.isCanvasUiCurrent(webViewId, scope)) {
              canvasUiComplete(requestId, '', 'canvas page was closed'); return;
            }
            try {
              if (error) throw new Error(error.message);
              const parsed: Object | string | null = JSON.parse(result);
              const json = typeof parsed === 'string' ? parsed : result;
              const feedback: Object | null = JSON.parse(json);
              if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback))
                throw new Error('invalid canvas feedback');
              const record = feedback as Record<string, Object>;
              if (!(typeof record['error'] === 'string' && record['error'] ||
                record['contexts'] && Array.isArray(record['typedArrays']))) throw new Error('empty canvas feedback');
              canvasUiComplete(requestId, json, '');
            } catch (error) { canvasUiComplete(requestId, '', (error as Error).message); }
          });
        } catch (error) {
          if (requestId) canvasUiComplete(requestId, '', (error as Error).message);
          else DMPLogger.e('', `canvas UI script failed: ${(error as Error).message}`);
        }
      });
      this.canvasUiScopes.set(webViewId, scope);
    } catch (error) {
      scope.closed = true;
      DMPLogger.e('', `canvas UI registration failed: ${(error as Error).message}`);
    }
  }

  private isCanvasUiCurrent(webViewId: number, scope: CanvasUiScope): boolean {
    return !scope.closed && this.canvasUiScopes.get(webViewId) === scope &&
      this.controllerMap.get(webViewId) === scope.controller && scope.controller.isControllerAttached &&
      (this.canvasGenerations.get(webViewId) ?? 0) === scope.generation;
  }

  public invalidateCanvasUi(webViewId: number, expectedController?: DMPWebViewController): void {
    if (expectedController && this.controllerMap.get(webViewId) !== expectedController) return;
    this.canvasGenerations.set(webViewId, (this.canvasGenerations.get(webViewId) ?? 0) + 1);
    const scope = this.canvasUiScopes.get(webViewId);
    this.canvasUiScopes.delete(webViewId);
    if (scope) {
      scope.closed = true;
      canvasUiUnregister(this.app.appIndex, webViewId, scope.token);
    }
  }

  getController(webViewId: number): DMPWebViewController {
    const controller = this.controllerMap.get(webViewId)
    return controller!
  }

  setController(webViewId: number,controller:DMPWebViewController){
    this.invalidateCanvasUi(webViewId);
    this.controllerMap.set(webViewId, controller)
  }

  removeController(webViewId: number) {
    this.invalidateCanvasUi(webViewId);
    this.controllerMap.delete(webViewId)
    this.pendingScripts.delete(webViewId)
  }

  public flushPendingScripts(webViewId: number) {
    const scripts = this.pendingScripts.get(webViewId)
    if (!scripts || scripts.length === 0) {
      return
    }
    this.pendingScripts.delete(webViewId)
    scripts.forEach((script: string) => {
      this.executeScript(script, webViewId)
    })
  }

  private enqueueScript(webViewId: number, script: string) {
    let scripts = this.pendingScripts.get(webViewId)
    if (!scripts) {
      scripts = []
      this.pendingScripts.set(webViewId, scripts)
    }
    scripts.push(script)
    if (scripts.length > this.maxPendingScriptCount) {
      scripts.shift()
    }
  }

  public fromContainerNext(data: DMPMap, webViewId: number) {
    const dataString = data.toStr();
    this.executeScript(`DiminaRenderBridge.onMessage(${dataString})`, webViewId)
  }

  public fromServiceNext(dataString: string, webViewId: number) {
    this.executeScript(`DiminaRenderBridge.onMessage(${dataString})`, webViewId)
  }

  public fromWebviewNext(data: DMPMap, webViewId: number) {
    if (this.app.render.getController(webViewId)) {
      const dataString = data.toStr();
      const controller = this.app.render.getController(webViewId)
      controller.subController && controller.subController.runJavaScript(`DiminaRenderBridge.onMessage(${dataString})`, (error, result) => {
        if (error) {
          DMPLogger.e('', `run webview JavaScript error: ` + JSON.stringify(error))
          return;
        }
      });
    }
  }

  public postMessage(data: DMPMap, webViewId: number) {
    const dataString = data.toStr();
    this.executeScript(`DiminaRenderBridge.onMessage(${dataString})`, webViewId)
  }
}
