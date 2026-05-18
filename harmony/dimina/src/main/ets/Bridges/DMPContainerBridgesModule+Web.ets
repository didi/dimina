import { Tags } from '../EventTrack/Tags'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPMap } from '../Utils/DMPMap'
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext'
import { DataTransformer } from '../Utils/DataTransformer'
import { DMPVideoManager } from '../Render/SameLayer/DMPVideoComponent'

export class DMPContainerBridgesModuleWeb extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return [
      'postMessage',
      'propsUpdate',
      'componentMount',
      'componentUnmount',
      'adjustPosition',
      'videoContext'
    ];
  }

  postMessage(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const subData: Map<string, object> = data.get('params')['data']
    const result = DataTransformer.eventContainerToWebView('bindWebviewPostMessage', subData, webViewId)
    DMPChannelProxyNext.ContainerToWebviewRender(result, this.app, webViewId)
  }

  propsUpdate(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    DMPLogger.d(Tags.BRIDGE, 'propsUpdate %{public}s', data.toStr())
    this.updateComponentParams(data, webViewId)
    this.invokeSuccessCallback(callback, null)
  }

  componentMount(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    DMPLogger.d(Tags.BRIDGE, 'componentMount %{public}s', data.toStr())
    this.updateComponentParams(data, webViewId)
    this.invokeSuccessCallback(callback, null)
  }

  componentUnmount(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    DMPLogger.d(Tags.BRIDGE, 'componentUnmount %{public}s', data.toStr())
    const stack = this.app.navigatorManager.getPageRecordById(webViewId)!
    const id = data.getString('id')
    if (id) {
      stack.componentParams.delete(id)
    }
    this.invokeSuccessCallback(callback, null)
  }

  videoContext(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const id = data.getString('id') ?? ''
    if (id.length > 0) {
      DMPVideoManager.sharedInstance().handleCommand(this.app.appIndex, webViewId, id, data)
    }
    this.invokeSuccessCallback(callback, null)
  }

  adjustPosition(data: DMPMap, callback: DMPBridgeCallback, webViewId: number) {
    const bottom = data.getNumber('bottom')
    const pageRecord = this.app.navigatorManager.getPageRecordById(webViewId)
    if (pageRecord) {
      pageRecord.adjustPosition = bottom ?? 0
    }
    this.invokeSuccessCallback(callback, null)
  }

  private updateComponentParams(data: DMPMap, webViewId: number) {
    const id = data.getString('id')
    if (!id) {
      return
    }
    const stack = this.app.navigatorManager.getPageRecordById(webViewId)
    if (!stack) {
      return
    }
    stack.componentParams.set(id, data)
    stack.componentParams[id] = data
    this.app.render.getController(webViewId)?.webContainer?.updateSameLayerNodeParams(id, data)
  }
}
