import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil'
import { DMPMap } from '../Utils/DMPMap'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import fs from '@ohos.file.fs'
import { buffer, util } from '@kit.ArkTS'

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

  private removePartialFile(filePath: string) {
    if (!filePath) return
    try {
      fs.unlinkSync(filePath)
    } catch (_) {
      // A path that was never created has nothing to clean up.
    }
  }

  private ensureCanvasDirectory(fileTmpDir: string, sandboxPath: string, appId: string): boolean {
    const directories: string[] = [
      sandboxPath,
      `${sandboxPath}/${appId}`,
      `${sandboxPath}/${appId}/resource`,
      `${sandboxPath}/${appId}/resource/tmp`,
    ]
    if (fileTmpDir !== directories[directories.length - 1]) return false
    try {
      for (const directory of directories) {
        if (!fs.accessSync(directory)) {
          try {
            fs.mkdirSync(directory)
          } catch (_) {
            // A concurrently created directory still passes the type and symlink checks below.
            if (!fs.accessSync(directory)) return false
          }
        }
        const stat = fs.lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false
      }
      return true
    } catch (_) {
      return false
    }
  }

  saveCanvasTempFile(data: DMPMap, callback: DMPBridgeCallback) {
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

    let stagingPath = ''
    let finalPath = ''
    let openedFile: fs.File | null = null
    try {
      const decoded = buffer.from(base64Data, 'base64')
      const bytes = new Uint8Array(decoded.length)
      const copied = decoded.copy(bytes, 0, 0, decoded.length)
      if (copied !== decoded.length) throw new Error('short base64 copy')
      if (!bytes.byteLength || bytes.byteLength > DMPContainerBridgesModuleCanvas.MAX_IMAGE_BYTES) {
        this.invokeCanvasFailure(callback, bytes.byteLength ? 'data too large' : 'invalid image data')
        return
      }
      if (!this.isMatchingImage(bytes, fileType)) {
        this.invokeCanvasFailure(callback, 'invalid image data')
        return
      }

      const fileMgr = DMPFileManager.sharedInstance()
      const fileTmpDir = fileMgr.appTmpDirectory(appId)
      if (!fileTmpDir) throw new Error('temp directory unavailable')
      if (!this.ensureCanvasDirectory(fileTmpDir, fileMgr.sandboxPath, appId)) {
        throw new Error('unsafe temp directory')
      }

      const token = util.generateRandomUUID()
      stagingPath = `${fileTmpDir}/.canvas_${token}.tmp`
      finalPath = `${fileTmpDir}/canvas_${token}.${fileType}`
      openedFile = fs.openSync(
        stagingPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.NOFOLLOW
      )
      const written = fs.writeSync(openedFile.fd, bytes.buffer, { length: bytes.byteLength })
      if (written !== bytes.byteLength) throw new Error('short write')
      fs.closeSync(openedFile)
      openedFile = null
      fs.moveFileSync(stagingPath, finalPath, 0)
      stagingPath = ''

      const result = new DMPMap()
      result.set('tempFilePath', DMPFileUrlConvertor.canvasTempVPath(`canvas_${token}.${fileType}`))
      result.set('errMsg', 'canvasToTempFilePath:ok')
      invokeCanvasResult(callback, result, DMPBridgeCallbackType.Success)
    } catch (error) {
      if (openedFile) {
        try {
          fs.closeSync(openedFile)
        } catch (_) {
          // Cleanup below remains authoritative.
        }
      }
      this.removePartialFile(stagingPath)
      this.removePartialFile(finalPath)
      DMPLogger.e('saveCanvasTempFile error: ' + error)
      this.invokeCanvasFailure(callback, 'write failed')
    }
  }
}
