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
      .onReady(() => {
        const id = this.params.id ?? ''
        const appIndex = this.params.appIndex ?? -1
        const webViewId = this.params.parentWebViewId ?? 0
        const w = this.params.width ?? 300
        const h = this.params.height ?? 150
        DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasComponent onReady id=${id} appIndex=${appIndex} webViewId=${webViewId} width=${w} height=${h} contextWidth=${this.context.width} contextHeight=${this.context.height}`)

        if (id) {
          DMPCanvasManager.sharedInstance().register(appIndex, webViewId, id, this.context,
            w, h)
        } else {
          DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasComponent onReady: id is EMPTY, cannot register. params=${JSON.stringify(this.params)}`)
        }
      })
  }
}
