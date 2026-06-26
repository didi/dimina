import { DMPLogger } from '../../EventTrack/DMPLogger'
import { Tags } from '../../EventTrack/Tags'
import { DMPMap } from '../../Utils/DMPMap'
import { DMPChannelProxyNext } from '../../Service/DMPChannelProxyNext'
import { DMPAppManager } from '../../DApp/DMPAppManager'
import { DMPApp } from '../../DApp/DMPApp'
import { image } from '@kit.ImageKit'
import { http } from '@kit.NetworkKit'

// Typed interfaces for canvas message structures (replaces raw object bracket access)

interface CanvasMessageBody {
  name: string
  params: CanvasFlushParams | CanvasRafParams | CanvasToDataURLParams | CanvasToTempFilePathParams
  bridgeId: number
}

interface CanvasMessageData {
  body: CanvasMessageBody
}

interface CanvasFlushParams {
  nodeId: string
  operations: CanvasOperation[]
}

interface CanvasRafParams {
  callback: string
  nodeId: string
  requestId: string
}

interface CanvasOperation {
  op: string
  contextId: string
  contextType: string
  prop: string
  value: Object
  method: string
  args: Object[]
  resultId: string
  resourceId: string
  imageId: string
  src: string
  onload: string
  onerror: string
}

interface CanvasSerializedResource {
  __canvasResourceId: string
}

interface CanvasSerializedImage {
  __canvasImageId: string
}

interface CanvasSerializedTypedArray {
  __canvasTypedArray: string
  data: number[]
}

interface CanvasSerializedArrayBuffer {
  __canvasArrayBuffer: boolean
  data: number[]
}

interface CanvasToDataURLParams {
  nodeId: string
  type: string
  quality: number
  callback: string
}

interface CanvasToTempFilePathParams {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
  destWidth: number
  destHeight: number
  fileType: string
  quality: number
  callback: string
}

interface CallbackArgs {
  width?: number
  height?: number
  errMsg?: string
  dataUrl?: string
  tempFilePath?: string
}

export class DMPCanvasManager {
  private static instance: DMPCanvasManager = new DMPCanvasManager()
  // componentId → CanvasRenderingContext2D
  private contexts: Map<string, CanvasRenderingContext2D> = new Map()
  // contextId (from JS) → CanvasRenderingContext2D
  private contextIdMap: Map<string, CanvasRenderingContext2D> = new Map()
  // resourceId → CanvasGradient (the only resource type that needs method calls)
  private gradients: Map<string, CanvasGradient> = new Map()
  // resourceId → generic resource for style references
  private resources: Map<string, CanvasGradient | CanvasPattern | ImageData> = new Map()
  // imageId → ImageBitmap
  private images: Map<string, ImageBitmap> = new Map()
  // JS canvas width/height per nodeId (set via setCanvasProperty from JS canvas.width/height)
  private jsCanvasSizes: Map<string, number[]> = new Map()
  // Native canvas vp width/height per componentId
  private nativeCanvasSizes: Map<string, number[]> = new Map()
  // Offscreen canvas for nodes where JS buffer size differs from native display size
  private offscreenCanvases: Map<string, OffscreenCanvas> = new Map()
  private offscreenContexts: Map<string, OffscreenCanvasRenderingContext2D> = new Map()
  // Pending flush messages that arrived before the canvas was registered
  private pendingFlushes: Map<string, Array<[CanvasFlushParams, number, number, number]>> = new Map()

  static sharedInstance(): DMPCanvasManager {
    return DMPCanvasManager.instance
  }

  register(appIndex: number, webViewId: number, componentId: string, ctx: CanvasRenderingContext2D,
    width: number = 300, height: number = 150): void {
    const key = componentId
    this.contexts.set(key, ctx)
    this.nativeCanvasSizes.set(key, [width, height])
    const registeredKeys: string[] = []
    this.contexts.forEach((_v: CanvasRenderingContext2D, k: string) => {
      registeredKeys.push(k)
    })
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager register: key=${key} appIndex=${appIndex} webViewId=${webViewId} nativeSize=[${width},${height}] dpr=${vp2px(1)} total=${this.contexts.size} keys=[${registeredKeys.join(', ')}]`)

    // Replay any pending flushes that arrived before this canvas was registered
    const pending = this.pendingFlushes.get(key)
    if (pending && pending.length > 0) {
      DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager register: replaying ${pending.length} pending flush(es) for ${key}`)
      this.pendingFlushes.delete(key)
      for (const entry of pending) {
        this.handleFlush(entry[0], entry[1], entry[2], entry[3])
      }
    }
  }

  unregister(componentId: string): void {
    this.contexts.delete(componentId)
    this.nativeCanvasSizes.delete(componentId)
    this.jsCanvasSizes.delete(componentId)
    this.offscreenCanvases.delete(componentId)
    this.offscreenContexts.delete(componentId)
    this.pendingFlushes.delete(componentId)
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager unregister: ${componentId}`)
  }

  getContext(componentId: string): CanvasRenderingContext2D | undefined {
    return this.contexts.get(componentId)
  }

  /**
   * Compute base scale to map JS canvas coordinate space to ArkUI Canvas vp coordinate space.
   * Web Canvas has independent buffer size (canvas.width/height) and display size (CSS).
   * ArkUI Canvas coordinate space always equals its vp component size.
   * When JS sets canvas.width = logicalW * dpr, then ctx.scale(dpr, dpr),
   * we need baseScale = nativeVpSize / jsCanvasSize to compensate.
   */
  private getBaseScale(nodeId: string): number[] {
    const jsSize = this.jsCanvasSizes.get(nodeId)
    if (!jsSize || jsSize[0] <= 0 || jsSize[1] <= 0) {
      return [1, 1]
    }
    // If offscreen canvas exists, use its dimensions as the native coordinate space
    const offCanvas = this.offscreenCanvases.get(nodeId)
    let nativeW: number
    let nativeH: number
    if (offCanvas) {
      nativeW = offCanvas.width
      nativeH = offCanvas.height
    } else {
      const nativeSize = this.nativeCanvasSizes.get(nodeId)
      if (!nativeSize) {
        return [1, 1]
      }
      nativeW = nativeSize[0]
      nativeH = nativeSize[1]
    }
    // Use uniform scale to preserve aspect ratio.
    const scaleX = nativeW / jsSize[0]
    const scaleY = nativeH / jsSize[1]
    const uniformScale = Math.min(scaleX, scaleY)
    return [uniformScale, uniformScale]
  }

  /**
   * Get the active drawing context for a node.
   * Prefers offscreen context (cast to CanvasRenderingContext2D) when available,
   * otherwise falls back to contextIdMap or on-screen context.
   */
  private getActiveContext(nodeId: string, contextId: string,
    fallback: CanvasRenderingContext2D): CanvasRenderingContext2D {
    const offCtx = this.offscreenContexts.get(nodeId)
    if (offCtx) {
      return offCtx as Object as CanvasRenderingContext2D
    }
    return this.contextIdMap.get(contextId) || fallback
  }

  /**
   * Quick string check to determine if a message should be intercepted.
   * Avoids full JSON parse for non-canvas messages.
   * Uses "name":"<value>" pattern to avoid false positives from page VDOM content
   * that may contain canvas-related text as UI strings.
   */
  shouldIntercept(dataString: string): boolean {
    return dataString.includes('"name":"canvasNodeFlush"') ||
      dataString.includes('"name":"createOffscreenCanvas"') ||
      dataString.includes('"name":"canvasNodeRequestAnimationFrame"') ||
      dataString.includes('"name":"canvasNodeToDataURL"') ||
      dataString.includes('"name":"canvasNodeToTempFilePath"')
  }

  /**
   * Parse and handle an intercepted canvas message.
   */
  handleMessage(dataString: string, webViewId: number, appIndex: number): void {
    try {
      const data: CanvasMessageData = JSON.parse(dataString) as CanvasMessageData
      const body = data.body
      if (!body) {
        DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleMessage: body is null`)
        return
      }
      const name = body.name
      const params = body.params
      const bridgeId = body.bridgeId
      DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager handleMessage: name=${name} bridgeId=${bridgeId}`)

      if (name === 'canvasNodeFlush') {
        this.handleFlush(params as CanvasFlushParams, webViewId, appIndex, bridgeId)
      } else if (name === 'canvasNodeRequestAnimationFrame') {
        this.handleRequestAnimationFrame(params as CanvasRafParams, webViewId, appIndex, bridgeId)
      } else if (name === 'canvasNodeToDataURL') {
        this.handleToDataURL(params as CanvasToDataURLParams, appIndex, bridgeId)
      } else if (name === 'canvasNodeToTempFilePath') {
        this.handleToTempFilePath(params as CanvasToTempFilePathParams, appIndex, bridgeId)
      } else {
        DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager handleMessage: unhandled name=${name}`)
      }
    } catch (e) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleMessage error: ${e}`)
    }
  }

  private handleFlush(params: CanvasFlushParams, webViewId: number, appIndex: number,
    bridgeId: number): void {
    const nodeId = params.nodeId
    const operations = params.operations
    if (!nodeId || !operations) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleFlush: missing nodeId=${nodeId} or operations=${operations}`)
      return
    }

    // nodeId equals componentId (set by Canvas.vue embed element id)
    const ctx = this.contexts.get(nodeId)
    if (!ctx) {
      // Canvas not registered yet (race condition: JS flush arrives before native aboutToAppear).
      // Buffer the flush so it can be replayed once the canvas registers.
      let queue = this.pendingFlushes.get(nodeId)
      if (!queue) {
        queue = []
        this.pendingFlushes.set(nodeId, queue)
      }
      queue.push([params, webViewId, appIndex, bridgeId])
      DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager handleFlush: canvas node ${nodeId} not yet registered, queued (pending=${queue.length})`)
      return
    }

    const opSummary = operations.map((op: CanvasOperation): string => op.op + (op.method ? ':' + op.method : op.prop ? ':' + op.prop : '')).join(', ')
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager handleFlush: nodeId=${nodeId} ops=${operations.length} [${opSummary}]`)
    for (const operation of operations) {
      this.executeOperation(ctx, operation, bridgeId, appIndex, webViewId, nodeId)
    }
  }

  private handleRequestAnimationFrame(params: CanvasRafParams, webViewId: number, appIndex: number,
    bridgeId: number): void {
    // In Harmony, requestAnimationFrame is not directly available in non-UI context.
    // We use setTimeout as an approximation to trigger the callback on next frame.
    const callbackId = params.callback
    if (!callbackId) {
      return
    }
    setTimeout(() => {
      const timestamp = Date.now()
      this.triggerCallback(bridgeId, appIndex, callbackId, timestamp)
    }, 16) // ~60fps
  }

  private handleToDataURL(params: CanvasToDataURLParams, appIndex: number, bridgeId: number): void {
    const nodeId = params.nodeId
    const callbackId = params.callback
    const offCtx = this.offscreenContexts.get(nodeId)
    const onScreenCtx = this.contexts.get(nodeId)
    if ((!offCtx && !onScreenCtx) || !callbackId) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleToDataURL: ctx or callback missing nodeId=${nodeId}`)
      if (callbackId) {
        const args: CallbackArgs = { errMsg: 'toDataURL:fail canvas not found' }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
      }
      return
    }

    try {
      const mimeType = params.type || 'image/png'
      const quality = params.quality
      let dataUrl: string
      // Prefer offscreen context (has full-resolution poster content)
      if (offCtx) {
        dataUrl = (quality !== undefined && quality !== null)
          ? offCtx.toDataURL(mimeType, quality) : offCtx.toDataURL(mimeType)
      } else {
        dataUrl = (quality !== undefined && quality !== null)
          ? onScreenCtx!.toDataURL(mimeType, quality) : onScreenCtx!.toDataURL(mimeType)
      }
      DMPLogger.i(Tags.WEB_COMPONENT,
        `DMPCanvasManager handleToDataURL: nodeId=${nodeId} type=${mimeType} offscreen=${!!offCtx} len=${dataUrl.length}`)
      const args: CallbackArgs = { dataUrl: dataUrl }
      this.triggerCallback(bridgeId, appIndex, callbackId, args)
    } catch (e) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleToDataURL error: ${e}`)
      const args: CallbackArgs = { errMsg: `toDataURL:fail ${e}` }
      this.triggerCallback(bridgeId, appIndex, callbackId, args)
    }
  }

  private handleToTempFilePath(params: CanvasToTempFilePathParams, appIndex: number,
    bridgeId: number): void {
    const nodeId = params.nodeId
    const callbackId = params.callback
    const offCtx = this.offscreenContexts.get(nodeId)
    const onScreenCtx = this.contexts.get(nodeId)
    if ((!offCtx && !onScreenCtx) || !callbackId) {
      DMPLogger.e(Tags.WEB_COMPONENT,
        `DMPCanvasManager handleToTempFilePath: ctx or callback missing nodeId=${nodeId}`)
      if (callbackId) {
        const args: CallbackArgs = { errMsg: 'canvasToTempFilePath:fail canvas not found' }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
      }
      return
    }

    try {
      const fileType = params.fileType || 'png'
      const quality = params.quality || 1.0
      const mimeType = fileType === 'jpg' ? 'image/jpeg' : 'image/png'
      const dataUrl = offCtx ? offCtx.toDataURL(mimeType, quality) : onScreenCtx!.toDataURL(mimeType, quality)

      // Decode base64 data URL to binary and write to temp file
      const base64Data = dataUrl.split(',')[1]
      if (!base64Data) {
        const args: CallbackArgs = { errMsg: 'canvasToTempFilePath:fail empty canvas' }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
        return
      }

      const buffer = this.base64ToArrayBuffer(base64Data)
      const tempDir = DMPApp.context?.cacheDir
      if (!tempDir) {
        const args: CallbackArgs = { errMsg: 'canvasToTempFilePath:fail no app context' }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
        return
      }
      const fileName = `canvas_${Date.now()}.${fileType}`
      const filePath = `${tempDir}/${fileName}`

      import('@ohos.file.fs').then((fileIo) => {
        const file = fileIo.default.openSync(filePath,
          fileIo.default.OpenMode.CREATE | fileIo.default.OpenMode.WRITE_ONLY)
        fileIo.default.writeSync(file.fd, buffer)
        fileIo.default.closeSync(file)
        DMPLogger.i(Tags.WEB_COMPONENT,
          `DMPCanvasManager handleToTempFilePath: saved ${filePath} size=${buffer.byteLength}`)
        const args: CallbackArgs = { tempFilePath: filePath }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
      }).catch((err: Error) => {
        DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleToTempFilePath fs error: ${err.message}`)
        const args: CallbackArgs = { errMsg: `canvasToTempFilePath:fail ${err.message}` }
        this.triggerCallback(bridgeId, appIndex, callbackId, args)
      })
      return
    } catch (e) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager handleToTempFilePath error: ${e}`)
      const args: CallbackArgs = { errMsg: `canvasToTempFilePath:fail ${e}` }
      this.triggerCallback(bridgeId, appIndex, callbackId, args)
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytes: number[] = []
    let i = 0
    while (i < base64.length) {
      const a = chars.indexOf(base64[i++])
      const b = chars.indexOf(base64[i++])
      const c = chars.indexOf(base64[i++])
      const d = chars.indexOf(base64[i++])
      bytes.push((a << 2) | (b >> 4))
      if (c !== -1) bytes.push(((b & 15) << 4) | (c >> 2))
      if (d !== -1) bytes.push(((c & 3) << 6) | d)
    }
    const buffer = new ArrayBuffer(bytes.length)
    const view = new Uint8Array(buffer)
    for (let j = 0; j < bytes.length; j++) {
      view[j] = bytes[j]
    }
    return buffer
  }

  private executeOperation(ctx: CanvasRenderingContext2D, operation: CanvasOperation,
    bridgeId: number, appIndex: number, webViewId: number, nodeId: string): void {
    const op = operation.op

    switch (op) {
      case 'getContext': {
        const contextId = operation.contextId
        // Map contextId to the native context
        this.contextIdMap.set(contextId, ctx)
        break
      }

      case 'contextSetProperty': {
        const contextId = operation.contextId
        const targetCtx = this.getActiveContext(nodeId, contextId, ctx)
        const prop = operation.prop
        const value: Object = this.resolveArg(operation.value)
        this.setContextProperty(targetCtx, prop, value)
        break
      }

      case 'contextCall': {
        const contextId = operation.contextId
        const targetCtx = this.getActiveContext(nodeId, contextId, ctx)
        const isOffscreenCtx = targetCtx !== ctx
        const method = operation.method
        const rawArgs: Object[] = operation.args || []
        const args: Object[] = rawArgs.map((arg: Object): Object => this.resolveArg(arg))
        const resultId = operation.resultId
        if (method === 'scale' || method === 'setTransform' || method === 'resetTransform') {
          DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager contextCall: ${method}(${JSON.stringify(args)}) nodeId=${nodeId} offscreen=${isOffscreenCtx}`)
        }
        const result = this.callContextMethod(targetCtx, method, args, nodeId)
        if (resultId && result !== undefined) {
          this.storeResource(resultId, result, method)
        }
        break
      }

      case 'resourceCall': {
        const resourceId = operation.resourceId
        const method = operation.method
        const rawArgs: Object[] = operation.args || []
        const args: Object[] = rawArgs.map((arg: Object): Object => this.resolveArg(arg))
        this.callResourceMethod(resourceId, method, args)
        break
      }

      case 'setCanvasProperty': {
        // JS sets canvas.width/height to define the drawing buffer coordinate space.
        // In Web Canvas, this is independent of the CSS display size.
        // In ArkUI Canvas, coordinate space equals vp component size.
        // When JS buffer size differs from native display size (e.g., poster generation),
        // we create an OffscreenCanvas matching the JS buffer dimensions (in vp).
        const prop = operation.prop
        const value = operation.value as number
        const nativeSize = this.nativeCanvasSizes.get(nodeId)
        if (!nativeSize) {
          break
        }
        const currentJsSize = this.jsCanvasSizes.get(nodeId) || [nativeSize[0], nativeSize[1]]
        if (prop === 'width') {
          currentJsSize[0] = value
        } else if (prop === 'height') {
          currentJsSize[1] = value
        }
        this.jsCanvasSizes.set(nodeId, currentJsSize)

        // Web behavior: setting canvas.width or canvas.height clears the visible canvas
        ctx.resetTransform()
        ctx.clearRect(0, 0, nativeSize[0], nativeSize[1])

        if (currentJsSize[0] > 0 && currentJsSize[1] > 0) {
          // Compute offscreen dimensions: JS buffer size converted to vp
          const dpr = vp2px(1)
          const offW = currentJsSize[0] / dpr
          const offH = currentJsSize[1] / dpr

          // Create offscreen only when JS buffer size differs from native canvas display size
          // (e.g., poster: CSS 300x150 but buffer 1089x6000)
          // When they match (interactive canvas: buffer = CSS * dpr), draw on visible canvas
          if (Math.abs(offW - nativeSize[0]) > 1 || Math.abs(offH - nativeSize[1]) > 1) {
            DMPLogger.d(Tags.WEB_COMPONENT,
              `DMPCanvasManager: creating OffscreenCanvas ${offW.toFixed(1)}x${offH.toFixed(1)} vp for jsSize ${currentJsSize[0]}x${currentJsSize[1]} (native ${nativeSize[0]}x${nativeSize[1]})`)
            const offCanvas = new OffscreenCanvas(offW, offH)
            const offCtx = offCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D
            this.offscreenCanvases.set(nodeId, offCanvas)
            this.offscreenContexts.set(nodeId, offCtx)
            // Apply base scale: offW/jsW = 1/dpr (uniform for both axes)
            const bs = offW / currentJsSize[0]
            offCtx.scale(bs, bs)
          } else {
            // Interactive canvas: remove offscreen if previously created, use on-screen
            this.offscreenCanvases.delete(nodeId)
            this.offscreenContexts.delete(nodeId)
            const bs = this.getBaseScale(nodeId)
            ctx.scale(bs[0], bs[1])
          }
        }

        const dprVal = vp2px(1)
        const hasOffscreen = this.offscreenCanvases.has(nodeId)
        const computedOffW = currentJsSize[0] / dprVal
        const computedOffH = currentJsSize[1] / dprVal
        const bs = hasOffscreen ? [computedOffW / currentJsSize[0], computedOffH / currentJsSize[1]] : this.getBaseScale(nodeId)
        DMPLogger.i(Tags.WEB_COMPONENT,
          `DMPCanvasManager setCanvasProperty: ${prop}=${value} jsSize=[${currentJsSize[0]},${currentJsSize[1]}] nativeSize=[${nativeSize[0]},${nativeSize[1]}] dpr=${dprVal} offW=${computedOffW.toFixed(2)} offH=${computedOffH.toFixed(2)} offscreen=${hasOffscreen} baseScale=[${bs[0].toFixed(4)},${bs[1].toFixed(4)}]`)
        break
      }

      case 'createImage': {
        // Will be handled when imageSetSrc is called
        break
      }

      case 'imageSetSrc': {
        const imageId = operation.imageId
        const src = operation.src
        const onload = operation.onload
        const onerror = operation.onerror
        this.handleImageSetSrc(imageId, src, onload, onerror, bridgeId, appIndex)
        break
      }

      default:
        DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager: unsupported op: ${op}`)
        break
    }
  }

  private storeResource(resultId: string, result: Object, method: string): void {
    if (method === 'createLinearGradient' || method === 'createRadialGradient') {
      this.gradients.set(resultId, result as CanvasGradient)
      this.resources.set(resultId, result as CanvasGradient)
    } else if (method === 'getImageData' || method === 'createImageData') {
      this.resources.set(resultId, result as ImageData)
    } else {
      this.resources.set(resultId, result as CanvasPattern)
    }
  }

  private callResourceMethod(resourceId: string, method: string, args: Object[]): void {
    // Gradient methods
    if (method === 'addColorStop') {
      const gradient = this.gradients.get(resourceId)
      if (gradient) {
        gradient.addColorStop(args[0] as number, args[1] as string)
      }
      return
    }
    DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager: unsupported resource method: ${method}`)
  }

  private setContextProperty(ctx: CanvasRenderingContext2D, prop: string, value: Object): void {
    switch (prop) {
      case 'fillStyle':
        ctx.fillStyle = value as string | number | CanvasGradient | CanvasPattern
        break
      case 'strokeStyle':
        ctx.strokeStyle = value as string | number | CanvasGradient | CanvasPattern
        break
      case 'lineWidth':
        ctx.lineWidth = value as number
        break
      case 'lineCap':
        ctx.lineCap = value as CanvasLineCap
        break
      case 'lineJoin':
        ctx.lineJoin = value as CanvasLineJoin
        break
      case 'miterLimit':
        ctx.miterLimit = value as number
        break
      case 'font':
        ctx.font = value as string
        break
      case 'textAlign':
        ctx.textAlign = value as CanvasTextAlign
        break
      case 'textBaseline':
        ctx.textBaseline = value as CanvasTextBaseline
        break
      case 'globalAlpha':
        ctx.globalAlpha = value as number
        break
      case 'globalCompositeOperation':
        ctx.globalCompositeOperation = value as string
        break
      case 'shadowBlur':
        ctx.shadowBlur = value as number
        break
      case 'shadowColor':
        ctx.shadowColor = value as string
        break
      case 'shadowOffsetX':
        ctx.shadowOffsetX = value as number
        break
      case 'shadowOffsetY':
        ctx.shadowOffsetY = value as number
        break
      case 'lineDashOffset':
        ctx.lineDashOffset = value as number
        break
      case 'imageSmoothingEnabled':
        ctx.imageSmoothingEnabled = value as boolean
        break
      case 'imageSmoothingQuality':
        ctx.imageSmoothingQuality = value as ImageSmoothingQuality
        break
      default:
        DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager: unknown property: ${prop}`)
        break
    }
  }

  private callContextMethod(ctx: CanvasRenderingContext2D, method: string,
    args: Object[], nodeId: string): Object | undefined {
    switch (method) {
    // Path methods
      case 'beginPath':
        ctx.beginPath()
        break
      case 'moveTo':
        ctx.moveTo(args[0] as number, args[1] as number)
        break
      case 'lineTo':
        ctx.lineTo(args[0] as number, args[1] as number)
        break
      case 'closePath':
        ctx.closePath()
        break
      case 'arc':
        ctx.arc(args[0] as number, args[1] as number, args[2] as number,
          args[3] as number, args[4] as number, (args[5] as boolean) || false)
        break
      case 'arcTo':
        ctx.arcTo(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number, args[4] as number)
        break
      case 'bezierCurveTo':
        ctx.bezierCurveTo(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number,
          args[4] as number, args[5] as number)
        break
      case 'quadraticCurveTo':
        ctx.quadraticCurveTo(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number)
        break
      case 'ellipse':
        ctx.ellipse(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number,
          args[4] as number, args[5] as number, args[6] as number,
          (args[7] as boolean) || false)
        break
      case 'rect':
        ctx.rect(args[0] as number, args[1] as number, args[2] as number, args[3] as number)
        break

    // Drawing methods
      case 'fill':
        ctx.fill()
        break
      case 'stroke':
        ctx.stroke()
        break
      case 'clip':
        ctx.clip()
        break
      case 'fillRect':
        ctx.fillRect(args[0] as number, args[1] as number, args[2] as number, args[3] as number)
        break
      case 'strokeRect':
        ctx.strokeRect(args[0] as number, args[1] as number, args[2] as number, args[3] as number)
        break
      case 'clearRect':
        ctx.clearRect(args[0] as number, args[1] as number, args[2] as number, args[3] as number)
        break

    // Text methods
      case 'fillText':
        if (args.length > 3) {
          ctx.fillText(args[0] as string, args[1] as number, args[2] as number, args[3] as number)
        } else {
          ctx.fillText(args[0] as string, args[1] as number, args[2] as number)
        }
        break
      case 'strokeText':
        if (args.length > 3) {
          ctx.strokeText(args[0] as string, args[1] as number, args[2] as number, args[3] as number)
        } else {
          ctx.strokeText(args[0] as string, args[1] as number, args[2] as number)
        }
        break
      case 'measureText':
        return ctx.measureText(args[0] as string) as Object

    // Transform methods
      case 'translate':
        ctx.translate(args[0] as number, args[1] as number)
        break
      case 'rotate':
        ctx.rotate(args[0] as number)
        break
      case 'scale':
        ctx.scale(args[0] as number, args[1] as number)
        break
      case 'transform':
        ctx.transform(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number,
          args[4] as number, args[5] as number)
        break
      case 'setTransform': {
        // Pre-multiply with base scale: combined = baseScale * userTransform
        // This maps JS canvas buffer coordinates to ArkUI vp coordinates
        const bs = this.getBaseScale(nodeId)
        ctx.setTransform(
          bs[0] * (args[0] as number), bs[1] * (args[1] as number),
          bs[0] * (args[2] as number), bs[1] * (args[3] as number),
          bs[0] * (args[4] as number), bs[1] * (args[5] as number)
        )
        break
      }
      case 'resetTransform': {
        ctx.resetTransform()
        // Re-apply base scale after reset so relative transforms still work correctly
        const bs = this.getBaseScale(nodeId)
        ctx.scale(bs[0], bs[1])
        break
      }

    // State methods
      case 'save':
        ctx.save()
        break
      case 'restore':
        ctx.restore()
        break

    // Gradient & Pattern methods
      case 'createLinearGradient':
        return ctx.createLinearGradient(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number) as Object
      case 'createRadialGradient':
        return ctx.createRadialGradient(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number,
          args[4] as number, args[5] as number) as Object

    // Image data methods
      case 'getImageData':
        return ctx.getImageData(args[0] as number, args[1] as number,
          args[2] as number, args[3] as number) as Object
      case 'putImageData': {
        const imageData = args[0] as ImageData
        if (args.length > 3) {
          ctx.putImageData(imageData, args[1] as number, args[2] as number,
            args[3] as number, args[4] as number, args[5] as number, args[6] as number)
        } else {
          ctx.putImageData(imageData, args[1] as number, args[2] as number)
        }
        break
      }
      case 'createImageData':
        if (args.length >= 2) {
          return ctx.createImageData(args[0] as number, args[1] as number) as Object
        }
        return ctx.createImageData(args[0] as ImageData) as Object

    // Line dash
      case 'setLineDash':
        ctx.setLineDash(args[0] as number[])
        break
      case 'getLineDash':
        return ctx.getLineDash() as Object

    // drawImage
      case 'drawImage': {
        const img = args[0] as ImageBitmap
        if (args.length === 9) {
          ctx.drawImage(img,
            args[1] as number, args[2] as number, args[3] as number, args[4] as number,
            args[5] as number, args[6] as number, args[7] as number, args[8] as number)
        } else if (args.length === 5) {
          ctx.drawImage(img,
            args[1] as number, args[2] as number, args[3] as number, args[4] as number)
        } else {
          ctx.drawImage(img, args[1] as number, args[2] as number)
        }
        break
      }

      default:
        DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager: unknown method: ${method}`)
        break
    }
    return undefined
  }

  /**
   * Resolve serialized canvas arguments back to native objects.
   * Mirrors runtime.js resolveCanvasArg.
   */
  private resolveArg(value: Object): Object {
    if (value === null || value === undefined) {
      return value
    }

    if (Array.isArray(value)) {
      const arr: Array<Object> = value as Array<Object>
      return arr.map((item: Object): Object => this.resolveArg(item))
    }

    if (typeof value !== 'object') {
      return value
    }

    // Wrap plain JSON object into DMPMap for safe property access
    const obj = DMPMap.createFromObject(value)

    // Resource reference (gradient, pattern, image, etc.)
    // CanvasImage also serializes as __canvasResourceId, so check images map as fallback
    const resourceId = obj.getString('__canvasResourceId')
    if (resourceId) {
      const resource = this.resources.get(resourceId)
      if (resource) {
        return resource as Object
      }
      const img = this.images.get(resourceId)
      if (img) {
        return img as Object
      }
      DMPLogger.d(Tags.WEB_COMPONENT, `DMPCanvasManager resolveArg: resource ${resourceId} not found in resources or images`)
      return value
    }

    // Image reference
    const imageId = obj.getString('__canvasImageId')
    if (imageId) {
      const img = this.images.get(imageId)
      if (img) {
        return img as Object
      }
      return value
    }

    // Typed array reconstruction
    const typedArrayType = obj.getString('__canvasTypedArray')
    if (typedArrayType) {
      const data: number[] = (obj.get('data') as number[]) || []
      return this.decodeTypedArray(typedArrayType, data) as Object
    }

    // ArrayBuffer reconstruction
    const isArrayBuffer = obj.getBoolean('__canvasArrayBuffer')
    if (isArrayBuffer) {
      const data: number[] = (obj.get('data') as number[]) || []
      return this.decodeArrayBuffer(data) as Object
    }

    // For plain objects, return as-is
    return value
  }

  private decodeTypedArray(typeName: string, data: number[]): ArrayBuffer | Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray {
    switch (typeName) {
      case 'Float32Array':
        return new Float32Array(data)
      case 'Float64Array':
        return new Float64Array(data)
      case 'Int8Array':
        return new Int8Array(data)
      case 'Int16Array':
        return new Int16Array(data)
      case 'Int32Array':
        return new Int32Array(data)
      case 'Uint8Array':
        return new Uint8Array(data)
      case 'Uint16Array':
        return new Uint16Array(data)
      case 'Uint32Array':
        return new Uint32Array(data)
      case 'Uint8ClampedArray':
        return new Uint8ClampedArray(data)
      default:
        return new Uint8Array(data)
    }
  }

  private decodeArrayBuffer(data: number[]): ArrayBuffer {
    const buffer = new ArrayBuffer(data.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < data.length; i++) {
      view[i] = data[i]
    }
    return buffer
  }

  private handleImageSetSrc(imageId: string, src: string, onload: string, onerror: string,
    bridgeId: number, appIndex: number): void {
    DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager handleImageSetSrc: imageId=${imageId} src=${src}`)
    if (src.startsWith('http://') || src.startsWith('https://')) {
      this.loadNetworkImage(imageId, src, onload, onerror, bridgeId, appIndex)
    } else {
      this.loadLocalImage(imageId, src, onload, onerror, bridgeId, appIndex)
    }
  }

  private loadLocalImage(imageId: string, src: string, onload: string, onerror: string,
    bridgeId: number, appIndex: number): void {
    try {
      const imageSource = image.createImageSource(src)
      this.createImageBitmapFromSource(imageSource, imageId, src, onload, onerror, bridgeId, appIndex)
    } catch (e) {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager: local image createSource failed: ${e}`)
      if (onerror) {
        const args: CallbackArgs = { errMsg: `createImage:fail ${src}` }
        this.triggerCallback(bridgeId, appIndex, onerror, args)
      }
    }
  }

  private loadNetworkImage(imageId: string, src: string, onload: string, onerror: string,
    bridgeId: number, appIndex: number): void {
    const httpRequest = http.createHttp()
    httpRequest.request(src, {
      method: http.RequestMethod.GET,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
    }).then((response: http.HttpResponse) => {
      if (response.responseCode === 200 && response.result) {
        try {
          const buffer = response.result as ArrayBuffer
          const imageSource = image.createImageSource(buffer)
          this.createImageBitmapFromSource(imageSource, imageId, src, onload, onerror, bridgeId, appIndex)
        } catch (e) {
          DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager: network image createSource failed: ${e}`)
          if (onerror) {
            const args: CallbackArgs = { errMsg: `createImage:fail ${src}` }
            this.triggerCallback(bridgeId, appIndex, onerror, args)
          }
        }
      } else {
        DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager: network image HTTP ${response.responseCode}`)
        if (onerror) {
          const args: CallbackArgs = { errMsg: `createImage:fail http ${response.responseCode}` }
          this.triggerCallback(bridgeId, appIndex, onerror, args)
        }
      }
      httpRequest.destroy()
    }).catch((err: Error) => {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager: network image request failed: ${err.message}`)
      if (onerror) {
        const args: CallbackArgs = { errMsg: `createImage:fail ${src}` }
        this.triggerCallback(bridgeId, appIndex, onerror, args)
      }
      httpRequest.destroy()
    })
  }

  private createImageBitmapFromSource(imageSource: image.ImageSource, imageId: string, src: string,
    onload: string, onerror: string, bridgeId: number, appIndex: number): void {
    imageSource.createPixelMap().then((pixelMap: image.PixelMap) => {
      const info = pixelMap.getImageInfoSync()
      const offCanvas = new OffscreenCanvas(info.size.width, info.size.height)
      const offCtx = offCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      offCtx.drawImage(pixelMap, 0, 0)
      const imageBitmap = offCanvas.transferToImageBitmap()
      this.images.set(imageId, imageBitmap)
      DMPLogger.i(Tags.WEB_COMPONENT, `DMPCanvasManager: image loaded imageId=${imageId} size=${info.size.width}x${info.size.height}`)
      if (onload) {
        const args: CallbackArgs = {
          width: info.size.width,
          height: info.size.height,
        }
        this.triggerCallback(bridgeId, appIndex, onload, args)
      }
    }).catch((err: Error) => {
      DMPLogger.e(Tags.WEB_COMPONENT, `DMPCanvasManager: image createPixelMap failed: ${err.message}`)
      if (onerror) {
        const args: CallbackArgs = { errMsg: `createImage:fail ${src}` }
        this.triggerCallback(bridgeId, appIndex, onerror, args)
      }
    })
  }

  private triggerCallback(bridgeId: number, appIndex: number, callbackId: string,
    args: CallbackArgs | number): void {
    const app = DMPAppManager.sharedInstance().getApp(appIndex)
    if (app) {
      const data = new DMPMap({
        'type': 'triggerCallback',
        'body': {
          'bridgeId': bridgeId,
          'id': callbackId,
          'args': args,
        }
      })
      DMPChannelProxyNext.ContainerToService(data, appIndex)
    }
  }
}
