import DMPCamera from './DMPCamera'
import grantPermission from './PermissionUtils'
import { BusinessError } from '@kit.BasicServicesKit'
import { CameraParams } from './DMPComponetParams'
import { DMPMap } from '../../Utils/DMPMap'
import { DMPLogger } from '../../EventTrack/DMPLogger'


// @Builder中为动态组件的具体组件内容。
@Builder
export function CameraBuilder(params: DMPMap) {
  CameraComponent({ params: params.toObject<CameraParams>() })
    .backgroundColor(Color.Pink)
}

@Component
struct CameraComponent {
  @Prop params: CameraParams
  @State bkColor: Color = Color.Red
  private surfaceId: string = '';
  private xComponentController: XComponentController = new XComponentController();
  @State private camera: DMPCamera = DMPCamera.sharedInstance();

  async aboutToAppear() {
    await grantPermission().then(() => {
      this.xComponentInit();
    }).catch((err: BusinessError) => {
      DMPLogger.e('[CameraModel]', `grantPermission failed ${JSON.stringify(err.code)}`);
    })
  }

  async xComponentInit() {
    // this.xcomponentController.setXComponentSurfaceSize({
    //   surfaceWidth: 200,
    //   surfaceHeight: 200
    // });

    this.camera = DMPCamera.sharedInstance()
    this.surfaceId = this.xComponentController.getXComponentSurfaceId();
    await this.camera.initCamera(this.surfaceId);
  }

  build() {
    // Column() {
    XComponent({
      id: 'xcomponent1',
      type: XComponentType.SURFACE,
      controller: this.xComponentController
    })
    // .onLoad(() => {
    // this.XComponentinit()
    // })
    // .backgroundColor(Color.Gray)
    // .width('340px')
    // .height('380px')
    // .width(200)
    // .height(200)

    // Button(this.params.textOne)
    //   .height(50)
    //   .width(200)
    //   .border({ width: 2, color: Color.Grey })
    //   .backgroundColor(Color.Orange)

    // Button(this.params.textTwo)
    //   .height(50)
    //   .width(200)
    //   .border({ width: 2, color: Color.Brown })
    //   .backgroundColor(Color.Orange)
    // }
    // .width(this.params['width'])
    // .height(this.params['height'])
  }
}
