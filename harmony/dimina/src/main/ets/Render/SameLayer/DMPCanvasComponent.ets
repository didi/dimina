import { DMPLogger } from '../../EventTrack/DMPLogger'
import { Tags } from '../../EventTrack/Tags'
import { DMPMap } from '../../Utils/DMPMap'
import { CanvasParams } from './DMPComponetParams'
import diminaNative from 'libdimina.so'

@Builder
export function CanvasBuilder(params: DMPMap) {
  DMPCanvasComponent({ params: params.toObject<CanvasParams>() })
}

@Component
struct DMPCanvasComponent {
  @Prop params: CanvasParams
  private controller: XComponentController = new XComponentController()
  private bindGeneration: number = 0

  aboutToDisappear(): void {
    const id = this.params.id ?? ''
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasComponent aboutToDisappear id=${id} gen=${this.bindGeneration}`)
    if (id && this.bindGeneration > 0) {
      diminaNative.canvasUnbindSurface(this.params.appIndex ?? -1, id, this.bindGeneration)
      this.bindGeneration = 0
    }
  }

  build() {
    XComponent({
      id: `canvas-xc-${this.params.id ?? ''}`,
      type: XComponentType.TEXTURE,
      controller: this.controller,
    })
      .width(this.params.width ?? 300)
      .height(this.params.height ?? 150)
      .backgroundColor('#00000000')
      .onLoad(() => {
        const id = this.params.id ?? ''
        const appIndex = this.params.appIndex ?? -1
        const surfaceId = this.controller.getXComponentSurfaceId()
        const w = this.params.width ?? 300
        const h = this.params.height ?? 150
        const dpr = vp2px(1)
        const pxW = Math.round(w * dpr)
        const pxH = Math.round(h * dpr)
        DMPLogger.i(Tags.WEB_COMPONENT,
          `DMPCanvasComponent onLoad id=${id} appIndex=${appIndex} surfaceId=${surfaceId} size=${w}x${h} px=${pxW}x${pxH} dpr=${dpr}`)

        if (id) {
          // canvasBindSurface handles dedup internally (skips if same surfaceId
          // is already bound with a live GL canvas).  Safe to call on every onLoad.
          this.bindGeneration = diminaNative.canvasBindSurface(appIndex, id, surfaceId, pxW, pxH, dpr)
          DMPLogger.i(Tags.WEB_COMPONENT,
            `DMPCanvasComponent bound id=${id} surfaceId=${surfaceId} gen=${this.bindGeneration}`)
        } else {
          DMPLogger.e(Tags.WEB_COMPONENT,
            `DMPCanvasComponent onLoad: id is EMPTY, cannot bind. params=${JSON.stringify(this.params)}`)
        }
      })
      .onDestroy(() => {
        const id = this.params.id ?? ''
        if (id && this.bindGeneration > 0) {
          diminaNative.canvasUnbindSurface(this.params.appIndex ?? -1, id, this.bindGeneration)
          this.bindGeneration = 0
        }
      })
  }
}
