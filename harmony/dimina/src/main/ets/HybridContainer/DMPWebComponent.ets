
import web_webview from '@ohos.web.webview'
import { DMPWebViewController } from './DMPWebViewController'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPNodeController } from '../Render/SameLayer/DMPNodeController'
import { NodeRenderType } from '@kit.ArkUI'
import { RequestCallback } from '../Render/UrlIntercepter/UrlInterceptor'
import { DMPRender } from '../Render/DMPRender'
import { DMPCommonDialog, ModalOption } from '../Bridges/Widget/DMPCommonDialog'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { NumberUtils } from '../Utils/DMPNumberUtils'
import { DMPMap } from '../Utils/DMPMap'
import { systemDateTime } from '@kit.BasicServicesKit'


@Component
export struct DMPWebComponent {
  @Prop
  appIndex: number
  @Prop
  webViewId: number
  // 引用了 render 对象是为了方便使用
  private readonly render: DMPRender = DMPAppManager.sharedInstance().getApp(this.appIndex)!.render
  private readonly controller: DMPWebViewController = this.render.getController(this.webViewId)
  // 同层渲染用到
  private sameLayerNodeControllerMap: Map<string, DMPNodeController> = new Map();
  @State componentIdArr: Array<string> = [];
  private requestCallback: RequestCallback = new RequestCallback(this.appIndex);
  startTime: number = 0
  endTime: number = 0

  aboutToAppear(): void {
    // 配置Web开启调试模式
    web_webview.WebviewController.setWebDebuggingAccess(true);
    this.controller.webContainer = this;
    this.startTime = systemDateTime.getTime()
    DMPLogger.i(Tags.DMP_WEB_COMPONENT, "aboutToAppear")
  }

  //这个createBuilder用来获取view的真实高度，一起位图信息
  @Builder
  createBuilder(builder: WrappedBuilder<[object]>, bubbleParams: object) {
    builder.builder(bubbleParams)
  }

  aboutToDisappear(): void {
    DMPLogger.i(Tags.DMP_WEB_COMPONENT, "aboutToDisappear")
    this.controller.webContainer = null;
    this.controller.notifyControllerDetached()
    this.render.removeController(this.webViewId)
  }

  onBack() {

  }

  @Builder
  content() {
    Stack() {
      ForEach(this.componentIdArr, (componentId: string) => {
        NodeContainer(this.sameLayerNodeControllerMap.get(componentId))
      }, (embedId: string) => embedId)

      Web({
        src: this.controller.loadPath(),
        controller: this.controller
      })
        .onConsole((msg) => {
          this.printLog(msg.message)
          return false
        })
        .cacheMode(CacheMode.Online)
        .fileAccess(true)
        .zoomAccess(false)
        .verticalScrollBarAccess(false)
        .domStorageAccess(true)
        .geolocationAccess(true)
        .javaScriptProxy(
          this.controller.genProxy()
        )
        .onAppear(() => {
          DMPLogger.d(Tags.DMP_WEB_COMPONENT, 'webViewId:' + this.webViewId + ' onAppear ')
        })
        .onDisAppear(() => {
          DMPLogger.d(Tags.DMP_WEB_COMPONENT, 'webViewId:' + this.webViewId + ' onDisAppear ')
        })
        .onPageBegin((event) => {
          DMPLogger.d(Tags.DMP_WEB_COMPONENT, 'webViewId:' + this.webViewId + ' onPageBegin ')
          this.controller.notifyPageBegin()
        })
        .onTitleReceive((event) => {
          if (event) {
            DMPLogger.d(`-onTitleReceive: ${event?.title}`)
          }
        })
        .onPageVisible(() => {
          DMPLogger.d(Tags.DMP_WEB_COMPONENT, 'webViewId:' + this.webViewId + ' onPageVisible')
        })
        .onPageEnd(() => {
          this.endTime = systemDateTime.getTime()
          const total = this.endTime - this.startTime;
          DMPLogger.d(Tags.DMP_WEB_COMPONENT, 'webViewId:' + this.webViewId + ' onPageEnd ' + total)
          this.controller.notifyPageEnd()
        })
        .onControllerAttached(() => {
          this.controller.notifyControllerAttached()
        })
        .onInterceptRequest(this.requestCallback.callback.bind(this.requestCallback))
        .onLoadIntercept((event) => {
          DMPLogger.d('onLoadIntercept', `url:${event.data.getRequestUrl()}`, `isMainFrame:${event.data.isMainFrame()}`,
            `isRedirect:${event.data.isRedirect()}`, `isRequestGesture:${event.data.isRequestGesture()}`)
          return false
        })
        .enableNativeEmbedMode(true)// 获取embed标签的生命周期变化数据。
        .onNativeEmbedLifecycleChange((embed) => {
          DMPLogger.d(Tags.WEB_COMPONENT, "NativeEmbed surfaceId" + embed.surfaceId + "embed.status=" + embed.status);
          const componentId = embed.info?.id?.toString() as string
          if (embed.status == NativeEmbedStatus.CREATE) {
            this.createSameLayerNode(embed, componentId)
          } else if (embed.status == NativeEmbedStatus.UPDATE) {
            this.updateSameLayerNode(embed, componentId)
          } else if (embed.status == NativeEmbedStatus.DESTROY) {
            this.destroySameLayerNode(embed, componentId)
          }
        })// 获取同层渲染组件触摸事件信息。
        .onNativeEmbedGestureEvent((touch) => {
          DMPLogger.d("NativeEmbed onNativeEmbedGestureEvent" + JSON.stringify(touch.touchEvent));
          this.componentIdArr.forEach((componentId: string) => {
            let nodeController = this.sameLayerNodeControllerMap.get(componentId)
            if (nodeController?.getEmbedId() === touch.embedId) {
              let ret = nodeController?.postEvent(touch.touchEvent)
              if (ret) {
                DMPLogger.d("onNativeEmbedGestureEvent success " + componentId)
              } else {
                DMPLogger.d("onNativeEmbedGestureEvent fail " + componentId)
              }
            }
          })
        })
        .expandSafeArea([SafeAreaType.KEYBOARD])

    }
  }

  private createSameLayerNode(embed: NativeEmbedDataInfo, componentId: string) {
    DMPLogger.d(Tags.WEB_COMPONENT, 'NativeEmbed create %{public}s', JSON.stringify(embed.info))
    // 创建节点控制器，设置参数并rebuild。
    let nodeController = new DMPNodeController(this.appIndex)
    const stack =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
    if (!stack) {
      DMPLogger.w(Tags.WEB_COMPONENT, '页面退出停止更新UI')
      return
    }
    const componentParams: DMPMap = this.getComponentParams(stack, componentId)

    nodeController.setRenderOption({
      surfaceId: embed.surfaceId as string,
      embedId: embed.embedId as string,
      renderType: NodeRenderType.RENDER_TYPE_TEXTURE,
      width: NumberUtils.toInt(px2vp(embed.info?.width)),
      height: NumberUtils.toInt(px2vp(embed.info?.height)),
      type: embed.info?.type as string,
      params: componentParams,
      parentWebViewId: this.webViewId
    })
    nodeController.rebuild()
    // 根据web传入的embed的id属性作为key，将nodeController存入map。
    this.sameLayerNodeControllerMap.set(componentId, nodeController)
    // 将web传入的embed的id属性存入@State状态数组变量中，用于动态创建nodeContainer节点容器，需要将push动作放在set之后。
    this.componentIdArr.push(componentId)
  }

  private updateSameLayerNode(embed: NativeEmbedDataInfo, componentId: string) {
    DMPLogger.d(Tags.WEB_COMPONENT, 'NativeEmbed update %{public}s', JSON.stringify(embed.info))
    let nodeController = this.sameLayerNodeControllerMap.get(componentId)

    const changeWidth = NumberUtils.toInt(px2vp(embed.info?.width));
    const changeHeight = NumberUtils.toInt(px2vp(embed.info?.height));
    if (changeWidth !== nodeController?.width ||
      changeHeight !== nodeController?.height) {
      const stack =
        DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
      if (!stack) {
        DMPLogger.w(Tags.WEB_COMPONENT, '页面退出停止更新UI')
        return
      }
      const componentParams: DMPMap = this.getComponentParams(stack, componentId)
      nodeController?.setRenderOption({
        surfaceId: embed.surfaceId as string,
        embedId: embed.embedId as string,
        renderType: NodeRenderType.RENDER_TYPE_TEXTURE,
        width: changeWidth,
        height: changeHeight,
        type: embed.info?.type as string,
        params: componentParams,
        parentWebViewId: this.webViewId
      })
      //这个更新会崩溃，先使用rebuild
      // nodeController?.updateNode({
      //   text: 'update',
      //   width: px2vp(embed.info?.width),
      //   height: px2vp(embed.info?.height)
      // } as ESObject)
      nodeController?.rebuild()
      DMPLogger.d(Tags.WEB_COMPONENT,
        "onNativeEmbedLifecycleChange rebuild width=" + embed.info?.width + "height=" + embed.info?.height)
    } else {
      DMPLogger.d(Tags.WEB_COMPONENT,
        "onNativeEmbedLifecycleChange no rebuild width=" + embed.info?.width + "height=" + embed.info?.height)
    }
  }

  private destroySameLayerNode(embed: NativeEmbedDataInfo, componentId: string) {
    DMPLogger.d(Tags.WEB_COMPONENT, 'NativeEmbed destroy %{public}s', JSON.stringify(embed.info))
    let nodeController = this.sameLayerNodeControllerMap.get(componentId)
    this.sameLayerNodeControllerMap.delete(componentId)
    nodeController?.dispose()
    const targetIndex = this.componentIdArr.indexOf(componentId);
    if (targetIndex != -1) {
      this.componentIdArr.splice(targetIndex, 1);
    }
  }

  public updateSameLayerNodeParams(componentId: string, params: DMPMap) {
    const stack =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
    if (!stack) {
      DMPLogger.w(Tags.WEB_COMPONENT, '页面退出停止更新UI')
      return
    }

    stack.componentParams.set(componentId, params)
    stack.componentParams[componentId] = params
    this.sameLayerNodeControllerMap.get(componentId)?.updateParams(params)
  }

  private getComponentParams(stack: DMPPageRecord, componentId: string): DMPMap {
    return stack.componentParams.get(componentId) ?? stack.componentParams[componentId] ?? new DMPMap()
  }

  private printLog(message?: ConsoleMessage) {
    if (message) {
      switch (message.getMessageLevel()) {
        case MessageLevel.Debug:
          DMPLogger.d(Tags.RENDER, message.getMessage())
          break
        case MessageLevel.Log:
          DMPLogger.d(Tags.RENDER, message.getMessage())
          break
        case MessageLevel.Info:
          DMPLogger.i(Tags.RENDER, message.getMessage())
          break
        case MessageLevel.Warn:
          DMPLogger.w(Tags.RENDER, message.getMessage())
          break
        case MessageLevel.Error:
          DMPLogger.e(Tags.RENDER, message.getMessage())
          break
        default:
          DMPLogger.d(Tags.RENDER, message.getMessage())
          break
      }
    }
  }

  build() {
    this.content()
  }

  //临时这样写，等鸿蒙5月份支持全局弹窗再替换
  showModel(options: ModalOption) {
    let dialogController: CustomDialogController = new CustomDialogController({
      alignment: DialogAlignment.Center,
      autoCancel: false,
      customStyle: true,
      builder: DMPCommonDialog({
        option: options
      })
    })
    //Dialog里面拿不到controller,而controller创建还依赖Dialog
    const realConfirm = options.confirm;
    const realCancel = options.cancel;
    options.confirm = () => {
      dialogController.close();
      realConfirm?.();
    }
    options.cancel = () => {
      dialogController.close();
      realCancel?.();
    }
    dialogController.open();
  }
}
