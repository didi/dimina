import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPMap } from '../Utils/DMPMap';
import { DMPAppManager } from '../DApp/DMPAppManager';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';

interface Message {
  type: string
  body: object
  target: string
}

export class DMPWebViewProxy {
  webViewId: number
  appIndex: number
  private allowCallingFrame: (() => boolean) | undefined

  constructor(webViewId: number, appIndex: number, allowCallingFrame?: () => boolean) {
    this.webViewId = webViewId
    this.appIndex = appIndex
    this.allowCallingFrame = allowCallingFrame
  }

  invoke(msg: Message): number | string | boolean | object {
    if (this.allowCallingFrame && !this.allowCallingFrame()) return false
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex);
    if (app) {
      return DMPChannelProxyNext.messageHandlerNext(msg.type, DMPMap.createFromObject(msg.body), msg.target, app);
    } else {
      DMPLogger.e(Tags.BRIDGE, '>>>>>>>app is dead')
      return new DMPMap();
    }
  }

  async publish(msg: string) {
    if (this.allowCallingFrame && !this.allowCallingFrame()) return
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex);
    if (app) {
      DMPChannelProxyNext.RenderToService(msg, app);
    } else {
      DMPLogger.e(Tags.BRIDGE, '>>>>>>>app is dead')
      return;
    }
  }

  async requestKeyboard(revision: number) {
    if (this.allowCallingFrame && !this.allowCallingFrame()) return
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    await app?.render.getController(this.webViewId)?.showFocusedKeyboard(revision)
  }
}
