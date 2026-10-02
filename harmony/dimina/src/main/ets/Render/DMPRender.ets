import { canvasError } from '../Service/DMPSendableObjects';
import { DMPApp } from '../DApp/DMPApp';
import { DMPWebViewController } from '../HybridContainer/DMPWebViewController';
import { AsyncCallback } from '@kit.BasicServicesKit';
import { DMPMap } from '../Utils/DMPMap';
import { BusinessError } from '@ohos.base';
import { DMPLogger } from '../EventTrack/DMPLogger';


export class DMPRender {
  controllerMap: Map<number, DMPWebViewController> = new Map()
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

  public canvasNodeSync(body: DMPMap): Promise<string> {
    const webViewId: number = body.get('bridgeId');
    const controller = this.controllerMap.get(webViewId);
    if (!controller?.isControllerAttached) {
      return Promise.resolve(canvasError('canvas page is unavailable'));
    }
    const script = `(() => { try { if (typeof globalThis.__diminaCanvasSync !== 'function') throw new Error('canvas runtime unavailable'); return JSON.stringify(globalThis.__diminaCanvasSync(${body.toStr()})); } catch (e) { return JSON.stringify({error:String(e)}); } })()`;
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
      }, 4500);
      try {
        // Earlier publish messages arrive through this same Worker FIFO and were
        // submitted to this controller before the query.
        controller.runJavaScript(script, (error, result) => {
          if (error) complete(canvasError(error.message));
          else if (this.controllerMap.get(webViewId) !== controller || !controller.isControllerAttached)
            complete(canvasError('canvas page was closed'));
          else {
            try {
              // ArkWeb versions may quote a returned JS string in JSON. Accept
              // either wire form, but never silently turn null into feedback.
              const parsed: Object | string | null = JSON.parse(result);
              const json = typeof parsed === 'string' ? parsed : result;
              const feedback: Object | null = JSON.parse(json);
              if (!feedback || typeof feedback !== 'object') throw new Error('invalid canvas feedback');
              complete(json);
            } catch (error) { complete(canvasError((error as Error).message)); }
          }
        });
      } catch (error) { complete(canvasError((error as Error).message)); }
    });
  }

  getController(webViewId: number): DMPWebViewController {
    const controller = this.controllerMap.get(webViewId)
    return controller!
  }

  setController(webViewId: number,controller:DMPWebViewController){
    this.controllerMap.set(webViewId, controller)
  }

  removeController(webViewId: number) {
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
