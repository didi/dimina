import diminaNative from 'libdimina.so'
import { DMPLogger } from '../EventTrack/DMPLogger'


export class DMPJSEngine {
  private isRun = false;
  private appIndex: number = -1;

  constructor() {
  }

  evalJS(script: string, sourceURL: string) {
    if (this.isRun) {
      diminaNative.dispatchJsTask(this.appIndex, script, sourceURL)
    } else {
      DMPLogger.w('', 'js engine is destroy')
    }
  }

  evalJSAb(ab: ArrayBuffer, sourceURL: string) {
    if (this.isRun) {
      diminaNative.dispatchJsTaskAb(this.appIndex, ab, sourceURL)
    } else {
      DMPLogger.w('', 'js engine is destroy')
    }
  }

  postMessage(message: object) {
    if (this.isRun) diminaNative.dispatchMessage(this.appIndex, message);
  }

  evalJSPath(path: string, sourceURL: string) {
    if (this.isRun) {
      diminaNative.dispatchJsTaskPath(this.appIndex, path, sourceURL)
    } else {
      DMPLogger.w('', 'js engine is destroy')
    }
  }

  destroy() {
    this.isRun = false
    diminaNative.destroyJsEngine(this.appIndex)
  }

  initWithWorker(appIndex: number,
    serviceToContainer: (t: number, id: number, d: string | object, a: ArrayBuffer) => number | string | boolean | object,
    isDebugMode: boolean,
    debuggerAddress: string,
    virtualFilePrefix: string) {
    this.appIndex = appIndex;

    this.isRun = true;

    diminaNative.StartJsEngine(this.appIndex, (t: number, id: number, data: string | object, ab: ArrayBuffer) => {
      // DMPLogger.d(Tags.JS_ENGINE, `StartJsEngine, ${t}, ${id}, ${data}`)
      return serviceToContainer(t, id, data, ab);
    }, isDebugMode, debuggerAddress, virtualFilePrefix)
  }
}
