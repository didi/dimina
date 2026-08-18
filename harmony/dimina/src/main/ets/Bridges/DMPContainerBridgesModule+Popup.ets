import { DMPMap } from '../Utils/DMPMap';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { DialogManager } from './Widget/DialogManager';

export class DMPContainerBridgesModulePopUp extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['showModal'];
  }

  showModal(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const targetWebViewId = webViewId > 0
      ? webViewId
      : this.app.navigatorManager.getActivePageRecord()?.webViewId
    const webContainer = targetWebViewId
      ? this.app.render.getController(targetWebViewId)?.webContainer
      : undefined
    webContainer?.setModalInteractionBlocked(true)

    let released = false
    const unblockPage = () => {
      if (released) {
        return
      }
      released = true
      webContainer?.setModalInteractionBlocked(false)
    }

    DialogManager.getInstance().showDialog({
      title: data.getString('title'),
      confirmText: data.getString('confirmText'),
      content: data.getString('content'),
      showCancel: data.getBoolean('showCancel') ?? true,
      cancelText: data.getString('cancelText') ?? '取消',
      cancelColor: data.getString('cancelColor') ?? "#000000",
      confirmColor: data.getString('confirmColor') ?? '#576B95',
      cancel: () => {
        unblockPage()
        this.invokeSuccessCallback(callback, new DMPMap({ "cancel": true }))
      },
      confirm: () => {
        unblockPage()
        this.invokeSuccessCallback(callback, new DMPMap({ "confirm": true }))
      },
      fail: () => {
        unblockPage()
        this.invokeFailureCallback(callback, null, 'showModal:fail')
      }
    })
  }
}


