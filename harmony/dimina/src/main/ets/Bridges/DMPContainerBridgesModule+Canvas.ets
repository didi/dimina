import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil'
import { DMPMap } from '../Utils/DMPMap'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import fs from '@ohos.file.fs'
import { util } from '@kit.ArkTS'

export function invokeCanvasResult(callback: DMPBridgeCallback, result: DMPMap,
  type: DMPBridgeCallbackType) {
  callback(result, type)
  callback(result, DMPBridgeCallbackType.Complete)
}

export class DMPContainerBridgesModuleCanvas extends DMPContainerBridgesModule {
  // Internal bridge safety ceiling, not a WeChat Canvas API limit. It bounds the
  // extra native allocation and temp-file write after the data URL crosses the bridge.
  private static readonly MAX_IMAGE_BYTES: number = 32 * 1024 * 1024
  private static readonly MAX_BASE64_CHARS: number = Math.floor(DMPContainerBridgesModuleCanvas.MAX_IMAGE_BYTES * 4 / 3) + 8

  getExportMethods(): string[] {
    return ['saveCanvasTempFile']
  }

  private invokeCanvasFailure(callback: DMPBridgeCallback, reason: string) {
    const result = new DMPMap()
    result.set('errMsg', `canvasToTempFilePath:fail ${reason}`)
    invokeCanvasResult(callback, result, DMPBridgeCallbackType.Fail)
  }

  private isValidAppId(appId: string): boolean {
    return appId !== '.' && appId !== '..' && /^[A-Za-z0-9._-]+$/.test(appId)
  }

  private isMatchingImage(bytes: Uint8Array, fileType: string): boolean {
    if (fileType === 'png') {
      const signature: number[] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
      if (bytes.byteLength < signature.length) return false
      return signature.every((value: number, index: number) => bytes[index] === value)
    }
    return bytes.byteLength >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
  }

  private async removePartialFile(filePath: string) {
    if (!filePath) return
    try {
      await fs.unlink(filePath)
    } catch (_) {
      // A path that was never created has nothing to clean up.
    }
  }

  private async ensureCanvasDirectory(fileTmpDir: string, sandboxPath: string, appId: string): Promise<boolean> {
    const directories: string[] = [
      sandboxPath,
      `${sandboxPath}/${appId}`,
      `${sandboxPath}/${appId}/resource`,
      `${sandboxPath}/${appId}/resource/tmp`,
    ]
    if (fileTmpDir !== directories[directories.length - 1]) return false
    try {
      for (const directory of directories) {
        if (!(await fs.access(directory))) {
          try {
            await fs.mkdir(directory)
          } catch (_) {
            // A concurrently created directory still passes the type and symlink checks below.
            if (!(await fs.access(directory))) return false
          }
        }
        const stat = await fs.lstat(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false
      }
      return true
    } catch (_) {
      return false
    }
  }

  async saveCanvasTempFile(data: DMPMap, callback: DMPBridgeCallback) {
    const dataURL = data.getString('dataURL') ?? ''
    const fileType = data.getString('fileType') ?? 'png'
    if (!dataURL) {
      this.invokeCanvasFailure(callback, 'dataURL is required')
      return
    }
    if (fileType !== 'png' && fileType !== 'jpg') {
      this.invokeCanvasFailure(callback, 'invalid file type')
      return
    }

    const app: DMPApp = this.app
    const appId = app.appConfig.appId
    if (!this.isValidAppId(appId)) {
      this.invokeCanvasFailure(callback, 'invalid appId')
      return
    }

    let base64Data = dataURL
    if (dataURL.startsWith('data:')) {
      const pngPrefix = 'data:image/png;base64,'
      const jpegPrefix = 'data:image/jpeg;base64,'
      const jpgPrefix = 'data:image/jpg;base64,'
      const expectedPrefix = fileType === 'png' ? pngPrefix : ''
      if (fileType === 'png' && !dataURL.startsWith(expectedPrefix)) {
        this.invokeCanvasFailure(callback, 'file type mismatch')
        return
      }
      if (fileType === 'jpg' && !dataURL.startsWith(jpegPrefix) && !dataURL.startsWith(jpgPrefix)) {
        this.invokeCanvasFailure(callback, 'file type mismatch')
        return
      }
      const comma = dataURL.indexOf(',')
      if (comma < 0) {
        this.invokeCanvasFailure(callback, 'invalid dataURL')
        return
      }
      base64Data = dataURL.substring(comma + 1)
    }
    if (!base64Data || base64Data.length > DMPContainerBridgesModuleCanvas.MAX_BASE64_CHARS) {
      this.invokeCanvasFailure(callback, base64Data ? 'data too large' : 'base64 decode failed')
      return
    }
    if (base64Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
      this.invokeCanvasFailure(callback, 'base64 decode failed')
      return
    }

    // 解码最多 32 MB 的 base64 再落盘是这条链上唯一的重活。saveCanvasTempFile 由 render 层
    // 发起，走的是主线程的模块表（worker 上只注册了 Http/Storage/File），同步做会直接卡住画面。
    // 因此解码走 Base64Helper 的 Promise 接口，文件操作全部走 fs 的 Promise 接口。
    let stagingPath = ''
    let finalPath = ''
    let openedFile: fs.File | null = null
    try {
      const bytes = await new util.Base64Helper().decode(base64Data, util.Type.BASIC)
      if (!bytes.byteLength || bytes.byteLength > DMPContainerBridgesModuleCanvas.MAX_IMAGE_BYTES) {
        this.invokeCanvasFailure(callback, bytes.byteLength ? 'data too large' : 'invalid image data')
        return
      }
      if (!this.isMatchingImage(bytes, fileType)) {
        this.invokeCanvasFailure(callback, 'invalid image data')
        return
      }
      // 解码结果不保证独占整个 ArrayBuffer，而 fs.write 收的是整个 buffer——直接交出去会把
      // 视图之外的字节也写进文件。只有确实带偏移时才用 slice 付这一次拷贝。
      const payload = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice()

      const fileMgr = DMPFileManager.sharedInstance()
      const fileTmpDir = fileMgr.appTmpDirectory(appId)
      if (!fileTmpDir) throw new Error('temp directory unavailable')
      if (!(await this.ensureCanvasDirectory(fileTmpDir, fileMgr.sandboxPath, appId))) {
        throw new Error('unsafe temp directory')
      }

      const token = util.generateRandomUUID()
      stagingPath = `${fileTmpDir}/.canvas_${token}.tmp`
      finalPath = `${fileTmpDir}/canvas_${token}.${fileType}`
      openedFile = await fs.open(
        stagingPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.NOFOLLOW
      )
      const written = await fs.write(openedFile.fd, payload.buffer, { length: payload.byteLength })
      if (written !== payload.byteLength) throw new Error('short write')
      await fs.close(openedFile)
      openedFile = null
      await fs.moveFile(stagingPath, finalPath, 0)
      stagingPath = ''

      const result = new DMPMap()
      result.set('tempFilePath', DMPFileUrlConvertor.canvasTempVPath(`canvas_${token}.${fileType}`))
      result.set('errMsg', 'canvasToTempFilePath:ok')
      invokeCanvasResult(callback, result, DMPBridgeCallbackType.Success)
    } catch (error) {
      if (openedFile) {
        try {
          await fs.close(openedFile)
        } catch (_) {
          // Cleanup below remains authoritative.
        }
      }
      await this.removePartialFile(stagingPath)
      await this.removePartialFile(finalPath)
      DMPLogger.e('saveCanvasTempFile error: ' + error)
      // 这个方法变成 async 之后，bridge 的 try/catch（只接同步抛错）不再兜得住它，
      // 回调链再抛就成了没有任何日志的 unhandled rejection。
      try {
        this.invokeCanvasFailure(callback, 'write failed')
      } catch (notifyError) {
        DMPLogger.e('saveCanvasTempFile failed to notify: ' + notifyError)
      }
    }
  }
}
