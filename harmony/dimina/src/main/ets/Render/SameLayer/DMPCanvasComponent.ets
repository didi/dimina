import { DMPLogger } from '../../EventTrack/DMPLogger'
import { Tags } from '../../EventTrack/Tags'
import { DMPMap } from '../../Utils/DMPMap'
import { DMPCanvasManager } from './DMPCanvasManager'
import { CanvasParams } from './DMPComponetParams'

@Builder
export function CanvasBuilder(params: DMPMap) {
  DMPCanvasComponent({ params: params.toObject<CanvasParams>() })
}

@Component
struct DMPCanvasComponent {
  @Prop params: CanvasParams
  private settings: RenderingContextSettings = new RenderingContextSettings(true)
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings)

  aboutToAppear(): void {
    const id = this.params.id ?? ''
    const appIndex = this.params.appIndex ?? -1
    const webViewId = this.params.parentWebViewId ?? 0
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasComponent aboutToAppear id=${id} appIndex=${appIndex} webViewId=${webViewId} width=${this.params.width} height=${this.params.height}`)
    if (id) {
      DMPCanvasManager.sharedInstance().register(appIndex, webViewId, id, this.context,
        this.params.width ?? 300, this.params.height ?? 150)
    } else {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasComponent aboutToAppear: id is EMPTY, cannot register. params=${JSON.stringify(this.params)}`)
    }
  }

  aboutToDisappear(): void {
    const id = this.params.id ?? ''
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasComponent aboutToDisappear id=${id}`)
    if (id) {
      DMPCanvasManager.sharedInstance().unregister(id)
    }
  }

  build() {
    Canvas(this.context)
      .width(this.params.width ?? 300)
      .height(this.params.height ?? 150)
      .backgroundColor('#00000000')
  }
}
