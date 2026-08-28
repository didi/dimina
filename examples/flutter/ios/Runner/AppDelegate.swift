import Dimina
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let diminaHost = DiminaFlutterHost()
  private var diminaChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let channel = FlutterMethodChannel(
      name: "com.didi.dimina/host",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    diminaChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      Task { @MainActor in
        guard let self else {
          result(FlutterError(code: "NO_HOST", message: "Host was released", details: nil))
          return
        }
        await self.handleDiminaCall(call, result: result)
      }
    }
  }

  @MainActor
  private func handleDiminaCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) async {
    let arguments = call.arguments as? [String: Any] ?? [:]
    do {
      switch call.method {
      case "openMiniProgram":
        guard let presenter = Self.visibleViewController() else {
          result(FlutterError(code: "NO_PRESENTER", message: "No visible view controller", details: nil))
          return
        }
        result(try await diminaHost.open(arguments: arguments, from: presenter))
      case "closeMiniProgram":
        let appId = arguments["appId"] as? String ?? ""
        result(try await diminaHost.close(appId: appId))
      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      result(FlutterError(code: "DIMINA_FAILED", message: error.localizedDescription, details: nil))
    }
  }

  @MainActor
  private static func visibleViewController() -> UIViewController? {
    guard let root = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .rootViewController
    else {
      return nil
    }

    var current = root
    while let presented = current.presentedViewController {
      current = presented
    }
    if let navigation = current as? UINavigationController {
      return navigation.visibleViewController ?? navigation
    }
    if let tab = current as? UITabBarController {
      return tab.selectedViewController ?? tab
    }
    return current
  }
}

@MainActor
private final class DiminaFlutterHost {
  private var apps: [String: DMPApp] = [:]

  func open(arguments: [String: Any], from presenter: UIViewController) async throws -> Bool {
    guard let appId = nonEmptyString(arguments["appId"]),
      let name = nonEmptyString(arguments["name"]),
      apps[appId] == nil
    else {
      return false
    }

    let navigationController = UINavigationController()
    await withCheckedContinuation { continuation in
      presenter.present(navigationController, animated: true) {
        continuation.resume()
      }
    }

    var appConfig = DMPAppConfig(appName: name, appId: appId)
    appConfig.isDebugMode = _isDebugAssertConfiguration()
    appConfig.updateManifestUrl = nonEmptyString(arguments["updateManifestUrl"])

    let app = DMPAppManager.sharedInstance().appWithConfig(appConfig: appConfig)
    app.getNavigator()?.setup(navigationController: navigationController)
    apps[appId] = app

    var launchConfig = DMPLaunchConfig()
    launchConfig.openType = .navigateTo
    launchConfig.appEntryPath = nonEmptyString(arguments["path"])
    await app.launch(launchConfig: launchConfig)
    return true
  }

  func close(appId: String) async throws -> Bool {
    guard let app = apps[appId] else { return false }
    try await app.closeMiniProgram()
    apps.removeValue(forKey: appId)
    return true
  }

  private func nonEmptyString(_ value: Any?) -> String? {
    guard let value = value as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
