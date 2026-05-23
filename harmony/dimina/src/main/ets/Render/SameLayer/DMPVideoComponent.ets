import { BusinessError } from '@ohos.base'
import { DMPFileUrlConvertor } from '../../Bundle/Util/DMPFileUrlConvertor'
import { DMPAppManager } from '../../DApp/DMPAppManager'
import { DMPLogger } from '../../EventTrack/DMPLogger'
import { Tags } from '../../EventTrack/Tags'
import { DMPChannelProxyNext } from '../../Service/DMPChannelProxyNext'
import { DMPMap } from '../../Utils/DMPMap'
import { VideoParams } from './DMPComponetParams'

interface DMPVideoHandle {
  play(): void
  pause(): void
  stop(): void
  seek(position: number): void
  playbackRate(rate: number): void
  requestFullScreen(direction?: number | string): void
  exitFullScreen(): void
}

class DMPVideoHandleImpl implements DMPVideoHandle {
  private playAction: () => void
  private pauseAction: () => void
  private stopAction: () => void
  private seekAction: (position: number) => void
  private playbackRateAction: (rate: number) => void
  private requestFullScreenAction: (direction?: number | string) => void
  private exitFullScreenAction: () => void

  constructor(playAction: () => void, pauseAction: () => void, stopAction: () => void,
    seekAction: (position: number) => void, playbackRateAction: (rate: number) => void,
    requestFullScreenAction: (direction?: number | string) => void, exitFullScreenAction: () => void) {
    this.playAction = playAction
    this.pauseAction = pauseAction
    this.stopAction = stopAction
    this.seekAction = seekAction
    this.playbackRateAction = playbackRateAction
    this.requestFullScreenAction = requestFullScreenAction
    this.exitFullScreenAction = exitFullScreenAction
  }

  play(): void {
    this.playAction()
  }

  pause(): void {
    this.pauseAction()
  }

  stop(): void {
    this.stopAction()
  }

  seek(position: number): void {
    this.seekAction(position)
  }

  playbackRate(rate: number): void {
    this.playbackRateAction(rate)
  }

  requestFullScreen(direction?: number | string): void {
    this.requestFullScreenAction(direction)
  }

  exitFullScreen(): void {
    this.exitFullScreenAction()
  }
}

export class DMPVideoManager {
  private static instance: DMPVideoManager = new DMPVideoManager()
  private handles: Map<string, DMPVideoHandle> = new Map()

  static sharedInstance(): DMPVideoManager {
    return DMPVideoManager.instance
  }

  register(appIndex: number, webViewId: number, id: string, handle: DMPVideoHandle) {
    this.handles.set(this.makeKey(appIndex, webViewId, id), handle)
  }

  unregister(appIndex: number, webViewId: number, id: string) {
    this.handles.delete(this.makeKey(appIndex, webViewId, id))
  }

  handleCommand(appIndex: number, webViewId: number, id: string, params: DMPMap): boolean {
    const handle = this.handles.get(this.makeKey(appIndex, webViewId, id))
    if (!handle) {
      DMPLogger.w(Tags.WEB_COMPONENT, `videoContext target not found: ${id}`)
      return false
    }

    const command = params.getString('command') ?? ''
    switch (command) {
      case 'play':
        handle.play()
        break
      case 'pause':
        handle.pause()
        break
      case 'stop':
        handle.stop()
        break
      case 'seek':
        handle.seek(params.getNumber('position') ?? 0)
        break
      case 'playbackRate':
        handle.playbackRate(params.getNumber('rate') ?? 1)
        break
      case 'requestFullScreen':
        handle.requestFullScreen(params.get('direction'))
        break
      case 'exitFullScreen':
        handle.exitFullScreen()
        break
      default:
        DMPLogger.d(Tags.WEB_COMPONENT, `Video command is not implemented: ${command}`)
        break
    }
    return true
  }

  private makeKey(appIndex: number, webViewId: number, id: string): string {
    return `${appIndex}:${webViewId}:${id}`
  }
}

@Builder
export function VideoBuilder(params: DMPMap) {
  VideoComponent({ params: params.toObject<VideoParams>() })
}

@Component
struct VideoComponent {
  @Prop params: VideoParams
  @State private duration: number = 0
  @State private playbackRateValue: number | string | PlaybackSpeed = PlaybackSpeed.Speed_Forward_1_00_X
  private controller: VideoController = new VideoController()
  private pendingPlay: boolean = false
  private initialTimeApplied: boolean = false

  aboutToAppear(): void {
    const id = this.videoId()
    const appIndex = this.appIndex()
    const webViewId = this.webViewId()
    const handle: DMPVideoHandle = new DMPVideoHandleImpl(
      (): void => this.play(),
      (): void => this.pause(),
      (): void => this.stop(),
      (position: number): void => this.seek(position),
      (rate: number): void => this.playbackRate(rate),
      (direction?: number | string): void => this.requestFullScreen(direction),
      (): void => this.exitFullScreen()
    )
    DMPVideoManager.sharedInstance().register(appIndex, webViewId, id, handle)
  }

  aboutToDisappear(): void {
    DMPVideoManager.sharedInstance().unregister(this.appIndex(), this.webViewId(), this.videoId())
  }

  build() {
    Stack() {
      Video({
        src: this.normalizeSrc(this.params.src),
        previewUri: this.normalizeSrc(this.params.poster),
        currentProgressRate: this.playbackRateValue,
        controller: this.controller
      })
        .width('100%')
        .height('100%')
        .controls(this.params.controls ?? true)
        .autoPlay(this.params.autoplay ?? false)
        .loop(this.params.loop ?? false)
        .muted(this.params.muted ?? false)
        .objectFit(this.toImageFit(this.params.objectFit))
        .onPrepared((event?: PreparedInfo) => {
          this.duration = event?.duration ?? this.params.duration ?? 0
          this.applyInitialTime()
          this.sendEvent('bindloadedmetadata', new DMPMap({
            duration: this.duration
          }))
          if (this.pendingPlay) {
            this.controller.start()
          }
        })
        .onStart(() => {
          this.pendingPlay = false
          this.sendEvent('bindplay')
        })
        .onPause(() => {
          this.pendingPlay = false
          this.sendEvent('bindpause')
        })
        .onFinish(() => {
          this.pendingPlay = false
          this.sendEvent('bindended')
        })
        .onFullscreenChange((event?: FullscreenInfo) => {
          this.sendEvent('bindfullscreenchange', new DMPMap({
            fullScreen: event?.fullscreen ?? false,
            direction: this.params.direction ?? 0
          }))
        })
        .onUpdate((event?: PlaybackInfo) => {
          this.sendEvent('bindtimeupdate', new DMPMap({
            currentTime: event?.time ?? 0,
            duration: this.duration
          }))
        })
        .onError((error?: BusinessError) => {
          this.pendingPlay = false
          this.sendEvent('binderror', new DMPMap({
            errMsg: error?.message ?? 'video error'
          }))
        })
    }
    .width(this.componentWidth())
    .height(this.componentHeight())
    .backgroundColor(Color.Black)
    .visibility(this.params.hidden ? Visibility.None : Visibility.Visible)
  }

  private play() {
    this.pendingPlay = true
    this.controller.start()
  }

  private pause() {
    this.pendingPlay = false
    this.controller.pause()
  }

  private stop() {
    this.pendingPlay = false
    this.controller.stop()
    this.sendEvent('bindpause')
  }

  private seek(position: number) {
    this.controller.setCurrentTime(Math.max(0, position))
  }

  private playbackRate(rate: number) {
    this.playbackRateValue = this.toPlaybackRate(rate)
  }

  private requestFullScreen(direction?: number | string) {
    const value = Number(direction ?? this.params.direction ?? 0)
    this.controller.requestFullscreen(value === 90 || value === -90)
  }

  private exitFullScreen() {
    this.controller.exitFullscreen()
  }

  private applyInitialTime() {
    const initialTime = this.params.initialTime ?? 0
    if (!this.initialTimeApplied && initialTime > 0) {
      this.initialTimeApplied = true
      this.controller.setCurrentTime(initialTime)
    }
  }

  private sendEvent(eventName: string, detail?: DMPMap) {
    const appIndex = this.appIndex()
    const webViewId = this.webViewId()
    const app = DMPAppManager.sharedInstance().getApp(appIndex)
    if (!app || webViewId <= 0) {
      return
    }

    const body = new DMPMap({
      id: this.videoId(),
      src: this.params.src ?? ''
    })
    if (detail) {
      body.setAll(detail)
    }
    DMPChannelProxyNext.ContainerToRender(new DMPMap({
      type: eventName,
      body: body.toJSON()
    }), app, webViewId)
  }

  private normalizeSrc(src?: string): string {
    if (!src) {
      return ''
    }
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('file://') ||
      src.startsWith('resource://') || src.startsWith('data:') || src.startsWith('internal://')) {
      return src
    }
    const localPath = DMPFileUrlConvertor.localPathFromVPath(src)
    if (localPath.startsWith('/')) {
      return `file://${localPath}`
    }
    return localPath
  }

  private toImageFit(value?: string): ImageFit {
    switch (value) {
      case 'fill':
        return ImageFit.Fill
      case 'cover':
        return ImageFit.Cover
      case 'contain':
      default:
        return ImageFit.Contain
    }
  }

  private toPlaybackRate(rate: number): number | string | PlaybackSpeed {
    switch (rate) {
      case 0.75:
        return PlaybackSpeed.Speed_Forward_0_75_X
      case 1:
        return PlaybackSpeed.Speed_Forward_1_00_X
      case 1.25:
        return PlaybackSpeed.Speed_Forward_1_25_X
      case 1.75:
        return PlaybackSpeed.Speed_Forward_1_75_X
      case 2:
        return PlaybackSpeed.Speed_Forward_2_00_X
      default:
        return rate > 0 ? rate : PlaybackSpeed.Speed_Forward_1_00_X
    }
  }

  private componentWidth(): number | string {
    return this.params.width && this.params.width > 0 ? this.params.width : '100%'
  }

  private componentHeight(): number | string {
    return this.params.height && this.params.height > 0 ? this.params.height : '100%'
  }

  private videoId(): string {
    return this.params.id ?? ''
  }

  private appIndex(): number {
    return this.params.appIndex ?? -1
  }

  private webViewId(): number {
    return this.params.parentWebViewId ?? 0
  }
}
