// 用于控制和反馈对应的NodeContainer上的节点的行为，需要与NodeContainer一起使用。
import { BuilderNode, FrameNode, NodeController, NodeRenderType } from '@kit.ArkUI';
import { CameraBuilder } from './DMPCameraComponent';
import { VideoBuilder } from './DMPVideoComponent';
import { DMPLogger } from '../../EventTrack/DMPLogger';
import { Tags } from '../../EventTrack/Tags';
import { DMPMap } from '../../Utils/DMPMap';
import { WebViewBuilder } from './DMPEmbedWebViewComponent';
import { MapBuilder } from './DMPMapComponent';


declare class nodeControllerParams {
  surfaceId: string
  type: string
  renderType: NodeRenderType
  embedId: string
  width: number
  height: number
  params: DMPMap
  parentWebViewId:number
}

export class DMPNodeController extends NodeController {
  private rootNode: BuilderNode<[DMPMap]> | undefined | null;
  private embedId_: string = "";
  private surfaceId_: string = "";
  private renderType_: NodeRenderType = NodeRenderType.RENDER_TYPE_DISPLAY;
  private _width_: number = 0;
  private _height_: number = 0;
  private type: string = "";
  private params: DMPMap | null | undefined;
  private parentWebViewId: number = 0;

  public get width(): number {
    return this._width_;
  }

  public get height(): number {
    return this._height_;
  }

  appIndex: number;

  constructor(appIndex: number) {
    super();
    this.appIndex = appIndex;
  }

  setRenderOption(params: nodeControllerParams) {
    this.surfaceId_ = params.surfaceId;
    this.renderType_ = params.renderType;
    this.embedId_ = params.embedId;
    this._width_ = params.width;
    this._height_ = params.height;
    this.type = params.type;
    this.parentWebViewId = params.parentWebViewId;
    this.params = params.params || new DMPMap();
    this.appendRuntimeParams()
  }

  updateParams(params: DMPMap) {
    const nextParams = params || new DMPMap();
    const shouldRebuild = this.shouldRebuildForParams(nextParams)
    this.params = nextParams;
    this.appendRuntimeParams()
    if (shouldRebuild) {
      this.rebuild()
    }
  }

  private appendRuntimeParams() {
    this.params?.set('width', this._width_)
    this.params?.set('height', this._height_)
    this.params?.set('appIndex', this.appIndex)
    this.params?.set('parentWebViewId', this.parentWebViewId)
  }

  private shouldRebuildForParams(nextParams: DMPMap): boolean {
    if (!this.params || this.type !== 'native/video') {
      return true
    }
    const keys: string[] = [
      'id',
      'src',
      'duration',
      'controls',
      'autoplay',
      'loop',
      'muted',
      'initialTime',
      'objectFit',
      'poster',
      'direction',
      'showProgress',
      'showFullscreenBtn',
      'showPlayBtn',
      'showCenterPlayBtn',
      'hidden'
    ]
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (this.params.get(key) !== nextParams.get(key)) {
        return true
      }
    }
    return false
  }

  // 必须要重写的方法，用于构建节点数、返回节点数挂载在对应NodeContainer中。
  // 在对应NodeContainer创建的时候调用、或者通过rebuild方法调用刷新。
  makeNode(uiContext: UIContext): FrameNode | null {
    DMPLogger.d(Tags.WEB_COMPONENT, 'NativeEmbed makeNode')
    this.rootNode = new BuilderNode(uiContext, { surfaceId: this.surfaceId_, type: this.renderType_ });
    if (this.type === 'native/video') {
      this.rootNode.build(wrapBuilder(VideoBuilder), this.params);
    } else if (this.type === 'native/camera') {
      this.rootNode.build(wrapBuilder(CameraBuilder), this.params);
    } else if (this.type === 'native/map') {
      this.rootNode.build(wrapBuilder(MapBuilder), this.params)
    } else if (this.type === 'native/webview'){
      this.rootNode.build(wrapBuilder(WebViewBuilder), this.params)
    }
    // 返回FrameNode节点。
    return this.rootNode.getFrameNode();
  }

  dispose() {
    if (this.rootNode) {
      this.rootNode.dispose();
    }
  }


  aboutToDisappear(): void {
    DMPLogger.i(Tags.WEB_COMPONENT, "DMPNodeController aboutToDisappear")
  }

  aboutToAppear(): void {
    DMPLogger.i(Tags.WEB_COMPONENT, "DMPNodeController aboutToAppear")
  }

  setBuilderNode(rootNode: BuilderNode<DMPMap[]> | null): void {
    this.rootNode = rootNode;
  }

  getBuilderNode(): BuilderNode<[DMPMap]> | undefined | null {
    return this.rootNode;
  }

  updateNode(arg: Object): void {
    this.rootNode?.update(arg);
  }

  getEmbedId(): string {
    return this.embedId_;
  }

  postEvent(event: TouchEvent | undefined): boolean {
    return this.rootNode?.postTouchEvent(event) as boolean
  }
}
