import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'dimina_host.dart';

void main() {
  runApp(const DiminaExampleApp());
}

class DiminaExampleApp extends StatelessWidget {
  const DiminaExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Dimina Flutter Example',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF246BFD)),
        useMaterial3: true,
      ),
      home: const DiminaLauncherPage(),
    );
  }
}

class DiminaLauncherPage extends StatefulWidget {
  const DiminaLauncherPage({super.key});

  @override
  State<DiminaLauncherPage> createState() => _DiminaLauncherPageState();
}

class _DiminaLauncherPageState extends State<DiminaLauncherPage> {
  final _formKey = GlobalKey<FormState>();
  final _appIdController = TextEditingController(text: 'wx92269e3b2f304afc');
  final _nameController = TextEditingController(text: 'WeUI for 小程序');
  final _pathController = TextEditingController(text: 'example/index');
  final _versionCodeController = TextEditingController(text: '66');
  final _versionNameController = TextEditingController(text: '1.0.65');
  final _manifestController = TextEditingController();
  final _host = const DiminaHost();

  bool _busy = false;
  String _status = '等待操作';

  @override
  void dispose() {
    _appIdController.dispose();
    _nameController.dispose();
    _pathController.dispose();
    _versionCodeController.dispose();
    _versionNameController.dispose();
    _manifestController.dispose();
    super.dispose();
  }

  Future<void> _openMiniProgram() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    await _run(() async {
      final accepted = await _host.openMiniProgram(
        appId: _appIdController.text.trim(),
        name: _nameController.text.trim(),
        path: _pathController.text.trim(),
        versionCode: int.parse(_versionCodeController.text.trim()),
        versionName: _versionNameController.text.trim(),
        updateManifestUrl: _manifestController.text.trim().isEmpty
            ? null
            : _manifestController.text.trim(),
      );
      return accepted ? '原生端已接受启动请求' : '原生端拒绝了启动请求';
    });
  }

  Future<void> _closeMiniProgram() async {
    final appId = _appIdController.text.trim();
    if (appId.isEmpty) {
      setState(() => _status = '请先填写 appId');
      return;
    }
    await _run(() async {
      final accepted = await _host.closeMiniProgram(appId);
      return accepted ? '原生端已接受关闭请求' : '当前没有运行中的 $appId';
    });
  }

  Future<void> _run(Future<String> Function() operation) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = '处理中…';
    });
    try {
      final status = await operation();
      if (mounted) setState(() => _status = status);
    } on PlatformException catch (error) {
      if (mounted) {
        setState(() => _status = '${error.code}: ${error.message ?? '未知错误'}');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Dimina Flutter 接入示例')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const Text('Flutter 只负责发起宿主请求，小程序页面和生命周期由各端 Dimina SDK 管理。'),
              const SizedBox(height: 20),
              _field(_appIdController, 'App ID'),
              _field(_nameController, '名称'),
              _field(_pathController, '入口路径'),
              _field(
                _versionCodeController,
                '版本号',
                keyboardType: TextInputType.number,
                validator: (value) =>
                    int.tryParse(value ?? '') == null ? '请输入整数' : null,
              ),
              _field(_versionNameController, '版本名称'),
              _field(
                _manifestController,
                '远程更新 Manifest（可选）',
                required: false,
                keyboardType: TextInputType.url,
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : _openMiniProgram,
                      child: const Text('打开小程序'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : _closeMiniProgram,
                      child: const Text('关闭小程序'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Semantics(
                liveRegion: true,
                child: Text(_status, key: const ValueKey('status')),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    bool required = true,
    TextInputType? keyboardType,
    String? Function(String?)? validator,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: controller,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
        keyboardType: keyboardType,
        validator:
            validator ??
            (value) => required && (value == null || value.trim().isEmpty)
                ? '不能为空'
                : null,
      ),
    );
  }
}
