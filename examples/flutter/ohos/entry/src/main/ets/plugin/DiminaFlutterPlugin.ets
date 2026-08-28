import {
  FlutterPlugin,
  MethodCall,
  MethodChannel
} from '@ohos/flutter_ohos';
import { FlutterPluginBinding } from '@ohos/flutter_ohos/src/main/ets/embedding/engine/plugins/FlutterPlugin';
import { MethodResult } from '@ohos/flutter_ohos/src/main/ets/plugin/common/MethodChannel';
import { DiminaFlutterHost } from '../host/DiminaFlutterHost';

const CHANNEL_NAME = 'com.didi.dimina/host';

export default class DiminaFlutterPlugin implements FlutterPlugin {
  private channel?: MethodChannel;

  onAttachedToEngine(binding: FlutterPluginBinding): void {
    this.channel = new MethodChannel(binding.getBinaryMessenger(), CHANNEL_NAME);
    this.channel.setMethodCallHandler({
      onMethodCall: (call: MethodCall, result: MethodResult): void => {
        this.onMethodCall(call, result);
      }
    });
  }

  onDetachedFromEngine(_binding: FlutterPluginBinding): void {
    this.channel?.setMethodCallHandler(null);
    this.channel = undefined;
  }

  getUniqueClassName(): string {
    return 'DiminaFlutterPlugin';
  }

  private onMethodCall(call: MethodCall, result: MethodResult): void {
    switch (call.method) {
      case 'openMiniProgram':
        this.openMiniProgram(call, result);
        break;
      case 'closeMiniProgram':
        this.closeMiniProgram(call, result);
        break;
      default:
        result.notImplemented();
        break;
    }
  }

  private openMiniProgram(call: MethodCall, result: MethodResult): void {
    const appId: string = call.argument('appId');
    const name: string = call.argument('name');
    const path: string = call.argument('path');
    const updateManifestUrl: string | undefined = call.argument('updateManifestUrl');
    DiminaFlutterHost.open(appId ?? '', name ?? '', path ?? '', updateManifestUrl)
      .then((accepted: boolean): void => result.success(accepted))
      .catch((error: Error): void => result.error('DIMINA_FAILED', error.message, null));
  }

  private closeMiniProgram(call: MethodCall, result: MethodResult): void {
    const appId: string = call.argument('appId');
    DiminaFlutterHost.close(appId ?? '')
      .then((accepted: boolean): void => result.success(accepted))
      .catch((error: Error): void => result.error('DIMINA_FAILED', error.message, null));
  }
}
