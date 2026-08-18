
import DMPCamera from '../Render/SameLayer/DMPCamera'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import fs from '@ohos.file.fs'
import { image } from '@kit.ImageKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { DMPApp } from '../DApp/DMPApp'
import cryptoFramework from '@ohos.security.cryptoFramework'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPMap } from '../Utils/DMPMap'
import { DMPLogger } from '../EventTrack/DMPLogger'


export class DMPContainerBridgesModuleCamera extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['takePhoto'];
  }

  takePhoto(data: DMPMap, callback: DMPBridgeCallback) {
    let q = 100
    if (data.hasKey('quality')) {
      let quality = null
      if (quality === "original") {
        q = 100
      } else if (quality === "high") {
        q = 75
      } else if (quality === "normal") {
        q = 60
      } else if (quality === "low") {
        q = 45
      }
    }

    let result: DMPMap = new DMPMap()
    const app: DMPApp = this.app!

    // 拿到组件对象，默认有且只有一个，拿到对象
    const camera: DMPCamera = DMPCamera.sharedInstance()
    const photoOutputCb: Function = async (buffer: ArrayBuffer) => {

      let imageSource = image.createImageSource(buffer)
      imageSource.getImageInfo()

      let md = cryptoFramework.createMd('SHA256');
      // 数据量较少时，可以只做一次update，将数据全部传入，接口未对入参长度做限制
      await md.update({ data: new Uint8Array(buffer) })
      let mdResult = await md.digest();
      let fileMgr = DMPFileManager.sharedInstance()
      const fileTmpDir = fileMgr.appTmpDirectory(app.appConfig.appId)

      const halfLength = Math.floor(mdResult.data.length / 2);
      // 文件名太长了，使用slice方法取前一半
      const firstHalfArray = mdResult.data.slice(0, halfLength);
      let name = firstHalfArray.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '')

      const filePath = fileTmpDir + "/" + name + ".jpg"

      let file = fs.openSync(filePath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE)
      const imagePackerApi = image.createImagePacker()
      let packOpts: image.PackingOption = { format: "image/jpeg", quality: q }
      // 直接打包进文件
      imagePackerApi.packToFile(imageSource, file.fd, packOpts).then(() => {
        let tempFilePath = DMPFileUrlConvertor.vPathFromLocalPath(filePath)
        // 返回给 Render
        result.set('tempImagePath', tempFilePath)
        this.invokeSuccessCallback(callback, result)
      }).catch((error: BusinessError) => {
        DMPLogger.e('', 'Failed to pack the image. And the error is: ' + error)
      })

    }
    // 监听照片输出
    camera.photoOutputCb = photoOutputCb
    // 拍照
    camera.takePicture()
  }


  startRecordCamera(data: Map<string, string>, callback: DMPBridgeCallback) {

  }

  stopRecordCamera(data: Map<string, string>, callback: DMPBridgeCallback) {

  }
}

