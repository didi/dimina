import 'package:dimina_flutter_example/dimina_host.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const host = DiminaHost();
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(DiminaHost.channel, (call) async {
          calls.add(call);
          return true;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(DiminaHost.channel, null);
  });

  test('openMiniProgram forwards the shared three-platform contract', () async {
    expect(
      await host.openMiniProgram(
        appId: 'wx-demo',
        name: 'Demo',
        path: 'pages/index',
        versionCode: 2,
        versionName: '2.0.0',
        updateManifestUrl: 'https://example.com/manifest.json',
      ),
      isTrue,
    );

    expect(calls.single.method, 'openMiniProgram');
    expect(calls.single.arguments, <String, Object?>{
      'appId': 'wx-demo',
      'name': 'Demo',
      'path': 'pages/index',
      'versionCode': 2,
      'versionName': '2.0.0',
      'updateManifestUrl': 'https://example.com/manifest.json',
    });
  });

  test('closeMiniProgram forwards the appId', () async {
    expect(await host.closeMiniProgram('wx-demo'), isTrue);
    expect(calls.single.method, 'closeMiniProgram');
    expect(calls.single.arguments, <String, Object?>{'appId': 'wx-demo'});
  });
}
