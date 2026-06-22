import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPMap } from '../Utils/DMPMap'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import fs from '@ohos.file.fs'
import { buffer } from '@kit.ArkTS'

export class DMPContainerBridgesModuleCanvas extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['saveCanvasTempFile']
  }

  saveCanvasTempFile(data: DMPMap, callback: DMPBridgeCallback) {
    const dataURL = data.getString('dataURL') ?? ''
    const fileType = data.getString('fileType') ?? 'png'

    if (!dataURL) {
      this.invokeFailureCallback(callback, null, 'saveCanvasTempFile:fail dataURL is empty')
      return
    }

    try {
      // Strip the data URL prefix (e.g. "data:image/png;base64,")
      const base64Prefix = new RegExp('^data:image/\\w+;base64,')
      const base64Data = dataURL.replace(base64Prefix, '')

      // Decode base64 to binary
      const buf = buffer.from(base64Data, 'base64')

      // Build temp file path
      const app: DMPApp = this.app
      const fileMgr = DMPFileManager.sharedInstance()
      const fileTmpDir = fileMgr.appTmpDirectory(app.appConfig.appId)

      // Ensure temp directory exists
      try {
        fs.mkdirSync(fileTmpDir, true)
      } catch (e) {
        DMPLogger.d('saveCanvasTempFile', 'tmp dir already exists or mkdir error: ' + e)
      }

      const ext = (fileType === 'jpg' || fileType === 'jpeg') ? 'jpg' : 'png'
      const timestamp = Date.now()
      const random = Math.floor(Math.random() * 100000)
      const fileName = `canvas_${timestamp}_${random}.${ext}`
      const filePath = `${fileTmpDir}/${fileName}`

      // Write to file
      const file = fs.openSync(filePath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE)
      fs.writeSync(file.fd, buf.buffer)
      fs.closeSync(file)

      // Convert to virtual path
      const tempFilePath = DMPFileUrlConvertor.vPathFromLocalPath(filePath)

      const result = new DMPMap()
      result.set('tempFilePath', tempFilePath)
      result.set('errMsg', 'canvasToTempFilePath:ok')
      this.invokeSuccessCallback(callback, result)
    } catch (error) {
      DMPLogger.e('saveCanvasTempFile error: ' + error)
      this.invokeFailureCallback(callback, null, `saveCanvasTempFile:fail ${error}`)
    }
  }
}
