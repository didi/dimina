import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil'
import { DMPMap } from '../Utils/DMPMap'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import fs from '@ohos.file.fs'
import { util } from '@kit.ArkTS'
import { CanvasExportJob, CanvasExportJobRegistry } from './CanvasExportJobRegistry'

// 小程序在 complete 里读 errMsg，所以 success/fail 派发抛错也不能把 complete 一起吞掉。
export function invokeCanvasResult(callback: DMPBridgeCallback, result: DMPMap,
  type: DMPBridgeCallbackType) {
  try {
    callback(result, type)
  } finally {
    callback(result, DMPBridgeCallbackType.Complete)
  }
}

// 同一个小程序同时只做一次解码加写盘。同步实现时主线程天然给它排队，改成异步之后就没有这层
// 约束了，而单次解码上限已经是 32 MB。作用域是 appId 而不是模块实例：模块图会随 runtime 重建，
// 挂在实例上的话，重启瞬间旧链还在写、新链已经能起第二次解码。同理，键只能是 appId 而不是 owner：
// owner 换代时旧任务仍在写盘，按 owner 分链会让新 runtime 的任务另起一条链和它并发。
// 这条链只约束解码与写盘阶段，排队中的每个请求仍各自持有自己那份 base64 字符串，总量由预算框住。
const canvasWriteQueues: Map<string, Promise<void>> = new Map()

export function enqueueCanvasWrite(job: CanvasExportJob, work: () => Promise<void>) {
  const queueKey = job.appId
  const previous = canvasWriteQueues.get(queueKey) ?? Promise.resolve()
  const next: Promise<void> = previous.then(work).catch((error: Object) => {
    // 队列本身不能被一次失败打断，后面排着的导出还要接着做。
    DMPLogger.e('saveCanvasTempFile queue error: ' + error)
  }).then(() => {
    // 链尾已经空了才回收，否则会丢掉后来者排在上面的那一段。
    if (canvasWriteQueues.get(queueKey) === next) {
      canvasWriteQueues.delete(queueKey)
    }
  })
  canvasWriteQueues.set(queueKey, next)
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

  // 回调 ID 属于发起这次调用的那个 runtime，而 ContainerToService 只按 appIndex 找 app，
  // 重启会换掉 service 却留着同一个 appIndex——迟到的回调会被投进新 runtime，撞上同 ID 的新回调。
  private isCurrentRuntime(app: DMPApp, generation: number): boolean {
    if (app.runtimeGeneration === generation) return true
    DMPLogger.i('saveCanvasTempFile: dropping a callback issued by a previous runtime')
    return false
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

    // 解码最多 32 MB 的 base64 再落盘是这条链上唯一的重活。saveCanvasTempFile 由 render 层
    // 发起，走的是主线程的模块表（worker 上只注册了 Http/Storage/File），同步做会直接卡住画面。
    // 因此解码走 Base64Helper 的 Promise 接口，文件操作全部走 fs 的 Promise 接口。
    // 这个方法是 javaScriptProxy 的同步返回值（DMPTSUtil.invokeNativeMethod 原样把它交还 ArkWeb），
    // 所以它自己必须保持同步：校验全在同步段完成，失败照旧同步回调，重活交给队列，不 await。
    // 声明成 async 会让返回值变成 pending Promise 穿过代理，也会让校验段的抛错逃出 bridge 的
    // 同步 try/catch，变成没有任何日志的 unhandled rejection。
    // 排队中的每个请求都各自留着自己那份 base64，直到轮到它才释放。单次上限只约束其中一份，
    // 连续入队时占用是累加的。允许「一份在写盘、一份在等」，再多就是纯堆积；预算判在入队之前，
    // 被拒的那份字符串不会被闭包捕获，随即可回收。
    const generation = app.runtimeGeneration
    const job = CanvasExportJobRegistry.reserve(appId, app.canvasExportOwner, base64Data)
    if (!job) {
      this.invokeCanvasFailure(callback, 'too many pending exports')
      return
    }
    enqueueCanvasWrite(job, async () => {
      const reservedPayload = CanvasExportJobRegistry.begin(job)
      if (reservedPayload === null) return
      try {
        await this.performCanvasWrite(reservedPayload, fileType, appId, app, generation, callback)
      } finally {
        CanvasExportJobRegistry.finish(job)
      }
    })
  }

  private async performCanvasWrite(base64Data: string, fileType: string, appId: string,
    app: DMPApp, generation: number, callback: DMPBridgeCallback) {
    let stagingPath = ''
    let finalPath = ''
    let openedFile: fs.File | null = null
    let tempFileName = ''
    let failure = ''
    try {
      const bytes = await new util.Base64Helper().decode(base64Data, util.Type.BASIC)
      if (!bytes.byteLength || bytes.byteLength > DMPContainerBridgesModuleCanvas.MAX_IMAGE_BYTES) {
        failure = bytes.byteLength ? 'data too large' : 'invalid image data'
      } else if (!this.isMatchingImage(bytes, fileType)) {
        failure = 'invalid image data'
      } else {
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
        tempFileName = `canvas_${token}.${fileType}`
        stagingPath = `${fileTmpDir}/.canvas_${token}.tmp`
        finalPath = `${fileTmpDir}/${tempFileName}`
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
      }
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
      finalPath = ''
      tempFileName = ''
      DMPLogger.e('saveCanvasTempFile error: ' + error)
      failure = 'write failed'
    }

    // 结算留在文件生命周期的 try 之外，且只做一次：派发本身抛错不能回过头来删掉已经交给
    // 小程序的那个文件，也不能在 success 之后再补一条 fail。
    if (!this.isCurrentRuntime(app, generation)) {
      // 发起这次导出的 runtime 已经没了，文件也没人会来取，直接清掉。
      await this.removePartialFile(finalPath)
      return
    }
    if (failure) {
      this.invokeCanvasFailure(callback, failure)
      return
    }
    const result = new DMPMap()
    result.set('tempFilePath', DMPFileUrlConvertor.canvasTempVPath(tempFileName))
    result.set('errMsg', 'canvasToTempFilePath:ok')
    invokeCanvasResult(callback, result, DMPBridgeCallbackType.Success)
  }
}
