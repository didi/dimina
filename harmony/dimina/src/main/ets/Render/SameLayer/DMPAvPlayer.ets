import media from '@ohos.multimedia.media';
import { BusinessError } from '@ohos.base';
import { DMPLogger } from '../../EventTrack/DMPLogger';

export class DMPAvPlayer {
  private count: number = 0;
  private surfaceID: string = ''; // surfaceID用于播放画面显示，具体的值需要通过Xcomponent接口获取，相关文档链接见上面Xcomponent创建方法。
  private isSeek: boolean = true; // 用于区分模式是否支持seek操作。

  setSurfaceID(surface_id: string) {
    DMPLogger.d('', 'setSurfaceID : ' + surface_id);
    this.surfaceID = surface_id;
  }

  // 注册avplayer回调函数。
  setAVPlayerCallback(avPlayer: media.AVPlayer) {
    // seek操作结果回调函数。
    avPlayer.on('seekDone', (seekDoneTime: number) => {
      DMPLogger.i('', `AVPlayer seek succeeded, seek time is ${seekDoneTime}`);
    })
    // error回调监听函数，当avplayer在操作过程中出现错误时，调用reset接口触发重置流程。
    avPlayer.on('error', (err: BusinessError) => {
      DMPLogger.e('', `Invoke avPlayer failed, code is ${err.code}, message is ${err.message}`);
      avPlayer.reset();
    })
    // 状态机变化回调函数。
    avPlayer.on('stateChange', async (state: string, reason: media.StateChangeReason) => {
      switch (state) {
        case 'idle': // 成功调用reset接口后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state idle called.');
          avPlayer.release(); // 调用release接口销毁实例对象。
          break;
        case 'initialized': // avplayer 设置播放源后触发该状态上报。
          DMPLogger.i('', 'AVPlayer state initialized called.');
          avPlayer.surfaceId = this.surfaceID; // 设置显示画面，当播放的资源为纯音频时无需设置。
          avPlayer.prepare();
          break;
        case 'prepared': // prepared调用成功后上报该状态机。
          DMPLogger.i('', 'AVPlayer state prepared called.');
          avPlayer.play(); // 调用播放接口开始播放。
          break;
        case 'playing': // play成功调用后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state prepared called.');
          if (this.count !== 0) {
            if (this.isSeek) {
              DMPLogger.i('', 'AVPlayer start to seek.');
              avPlayer.seek(avPlayer.duration); // seek到视频末尾。
            } else {
              // 当播放模式不支持seek操作时继续播放到结尾。
              DMPLogger.i('', 'AVPlayer wait to play end.');
            }
          } else {
            avPlayer.pause(); // 调用暂停接口暂停播放。
          }
          this.count++;
          break;
        case 'paused': // pause成功调用后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state paused called.');
          avPlayer.play(); // 再次播放接口开始播放。
          break;
        case 'completed': //播放接口后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state paused called.');
          avPlayer.stop(); // 调用播放接口接口。
          break;
        case 'stopped': // stop接口后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state stopped called.');
          avPlayer.reset(); // 调用reset接口初始化avplayer状态。
          break;
        case 'released': //播放接口后触发该状态机上报。
          DMPLogger.i('', 'AVPlayer state released called.');
          break;
        default:
          break;
      }
    })
  }

  // 通过url设置网络地址来实现播放直播码流。
  async avPlayerLive(src: string) {
    // 创建avPlayer实例对象
    let avPlayer: media.AVPlayer = await media.createAVPlayer();
    // 创建状态机变化回调函数。
    this.setAVPlayerCallback(avPlayer);
    this.isSeek = false; // 不支持seek操作。
    avPlayer.url = src;
  }
}
