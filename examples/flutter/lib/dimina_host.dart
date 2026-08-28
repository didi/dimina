import 'package:flutter/services.dart';

final class DiminaHost {
  const DiminaHost();

  static const channelName = 'com.didi.dimina/host';
  static const MethodChannel channel = MethodChannel(channelName);

  Future<bool> openMiniProgram({
    required String appId,
    required String name,
    required String path,
    required int versionCode,
    required String versionName,
    String? updateManifestUrl,
  }) async {
    return await channel.invokeMethod<bool>(
          'openMiniProgram',
          <String, Object?>{
            'appId': appId,
            'name': name,
            'path': path,
            'versionCode': versionCode,
            'versionName': versionName,
            'updateManifestUrl': updateManifestUrl,
          },
        ) ??
        false;
  }

  Future<bool> closeMiniProgram(String appId) async {
    return await channel.invokeMethod<bool>(
          'closeMiniProgram',
          <String, Object?>{'appId': appId},
        ) ??
        false;
  }
}
