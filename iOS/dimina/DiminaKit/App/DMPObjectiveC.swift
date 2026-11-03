import Foundation
import UIKit

/// Objective-C configuration. The Swift value is captured when creating an app.
@objcMembers
public final class DMPObjCAppConfig: NSObject {
    public let appName: String
    public let appId: String
    public var isDebugMode = false
    public var updateManifestUrl: String?

    public init(appName: String, appId: String) {
        self.appName = appName
        self.appId = appId
        super.init()
    }

    fileprivate var swiftValue: DMPAppConfig {
        var config = DMPAppConfig(appName: appName, appId: appId)
        config.isDebugMode = isDebugMode
        config.updateManifestUrl = updateManifestUrl
        return config
    }
}

@objc public enum DMPObjCOpenType: Int {
    case navigateTo
    case insert
}

/// NSNumber preserves the Swift API's distinction between nil and false/zero.
@objcMembers
public final class DMPObjCLaunchConfig: NSObject {
    public var openType: DMPObjCOpenType = .navigateTo
    public var appEntryPath: String?
    public var query: [String: Any]?
    public var launchAnimated: NSNumber?
    public var isRelaunch: NSNumber?
    public var appOpenUrl: String?
    public var scene: NSNumber?
    public var referrerInfo: [String: Any]?

    fileprivate var swiftValue: DMPLaunchConfig {
        DMPLaunchConfig(
            openType: openType == .insert ? .insert : .navigateTo,
            appEntryPath: appEntryPath,
            query: query,
            launchAnimated: launchAnimated?.boolValue,
            isRelaunch: isRelaunch?.boolValue,
            appOpenUrl: appOpenUrl,
            scene: scene?.intValue,
            referrerInfo: referrerInfo
        )
    }
}

/// Call on the main thread. Completion blocks are invoked once on the main thread.
@MainActor
@objcMembers
public final class DMPObjCApp: NSObject {
    private let app: DMPApp

    fileprivate init(app: DMPApp) {
        self.app = app
        super.init()
    }

    public var appId: String { app.getAppId() }

    /// Configure the navigation container before the first launch.
    public func setup(navigationController: UINavigationController) {
        app.getNavigator()?.setup(navigationController: navigationController)
    }

    /// Success means the native launch path accepted/prepared the app, not JS onReady.
    @objc(launchWithConfig:completion:)
    public func launch(config: DMPObjCLaunchConfig, completion: @escaping (Bool) -> Void) {
        let snapshot = config.swiftValue
        Task { @MainActor in
            let launched = await app.launchForMiniProgramNavigation(launchConfig: snapshot)
            completion(launched)
        }
    }

    @objc(hideWithCompletion:)
    public func hide(completion: @escaping (NSError?) -> Void) {
        Task { @MainActor in
            do {
                try await app.hideMiniProgram()
                completion(nil)
            } catch { completion(error as NSError) }
        }
    }

    @objc(closeWithCompletion:)
    public func close(completion: @escaping (NSError?) -> Void) {
        Task { @MainActor in
            do {
                try await app.closeMiniProgram()
                completion(nil)
            } catch { completion(error as NSError) }
        }
    }
}

/// An Objective-C facade over the same singleton and app pool used by Swift hosts.
@MainActor
@objcMembers
public final class DMPObjCManager: NSObject {
    public static let shared = DMPObjCManager()
    private let manager = DMPAppManager.sharedInstance()

    private override init() { super.init() }

    public var showCapsule: Bool {
        get { manager.showCapsule }
        set { manager.showCapsule = newValue }
    }

    public var capsuleBackgroundColor: UIColor {
        get { manager.capsuleBackgroundColor }
        set { manager.capsuleBackgroundColor = newValue }
    }

    public var showLaunchLoading: Bool {
        get { manager.showLaunchLoading }
        set { manager.showLaunchLoading = newValue }
    }

    public func setup(apiNamespaces: [String]) {
        manager.setup(apiNamespaces: apiNamespaces)
    }

    @objc(appWithConfig:)
    public func app(config: DMPObjCAppConfig) -> DMPObjCApp {
        DMPObjCApp(app: manager.appWithConfig(appConfig: config.swiftValue))
    }

    @objc(destroyAllMiniProgramsWithCompletion:)
    public func destroyAllMiniPrograms(completion: @escaping (NSError?) -> Void) {
        Task { @MainActor in
            do {
                try await manager.destroyAllMiniPrograms()
                completion(nil)
            } catch { completion(error as NSError) }
        }
    }
}
