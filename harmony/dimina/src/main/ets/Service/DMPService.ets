import { DMPMap } from '../Utils/DMPMap'
import { DMPWorkerWrapper } from './DMPWorkerWrapper'
import { WorkerAppData } from './DMPSendableObjects'
import { DMPAppManager } from '../DApp/DMPAppManager';
import { DMPApp } from '../DApp/DMPApp';
import { buffer, util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { DMPLogger } from '../EventTrack/DMPLogger';


export class DMPService {
  appIndex: number;
  ww: DMPWorkerWrapper;
  appData = new WorkerAppData();

  constructor(appIndex: number) {
    this.appIndex = appIndex
    this.ww = new DMPWorkerWrapper(appIndex)
    // this.ww.updateWorkerAppData(new WorkerAppData())
    this.initJsEngine()
  }

  public initJsEngine() {
    this.ww.initEngine(this.appIndex)
  }

  public async initBridges() {
  }

  public executeScript(script: string) {
    this.executeScriptAb(this.stringToArrayBuffer(script));
  }

  public executeScriptAb(ab: ArrayBuffer) {
    this.ww.evalJSAb(ab)
  }

  public async loadFileUri(uri: string) {
    // debug 模式放在 worker 加载还是有时序问题，就还是放在主线程阻塞加载
    if (uri.startsWith("http")) {
      DMPLogger.i('', `evalJSByUri 1 ${uri}`);
      let httpRequest = http.createHttp();
      const data: http.HttpResponse = await httpRequest.request(uri);
      const c: string = data.result as string;
      DMPLogger.i('', `evalJSByUri 2 ${uri}`);
      this.executeScript(c);
    } else {
      this.ww.evalJSByUri(uri);
    }
  }

  public fromContainerNext(data: DMPMap) {
    const dataString = data.toStr()
    const script: string = `DiminaServiceBridge.onMessage(${dataString})`
    // this.ww.evalJS(script)
    this.executeScript(script)
  }

  public fromRender(dataString: string) {
    const script: string = `DiminaServiceBridge.onMessage(${dataString})`
    // this.ww.evalJS(script)
    this.executeScript(script)
  }

  public postMessage(data: DMPMap) {
    const dataString = data.toStr()
    const script: string = `DiminaServiceBridge.onMessage(${dataString})`
    // this.ww.evalJS(script)
    this.executeScript(script)
  }

  /** Wait until the service Worker has executed every script queued so far. */
  public flush(): Promise<void> {
    return this.ww.flush()
  }

  public updateWorkerAppData() {
    const app: DMPApp | undefined = DMPAppManager.sharedInstance().getApp(this.appIndex);
    if (app) {
      this.appData.appIndex = this.appIndex;
      this.appData.appId = app.appConfig.appId;
      this.appData.jsAppVersion = app.bundleManager.bundleLoader.getJsAppVersion();
      this.ww.updateWorkerAppData(this.appData);
    }
  }

  public destroy() {
    this.ww.destroy()
  }

  private stringToArrayBuffer(str: string): ArrayBuffer {
    let textEncoder = new util.TextEncoder();
    let result = textEncoder.encodeInto(str);
    let togglesA = new ArrayBuffer(result.length);
    buffer.from(togglesA).write(str)
    return togglesA;
  }
}
