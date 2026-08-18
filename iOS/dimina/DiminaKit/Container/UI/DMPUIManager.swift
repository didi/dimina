import UIKit

public class DMPUIManager {
    public static let shared = DMPUIManager()

    private init() {}

    public func getStatusBarHeight() -> CGFloat {
        if #available(iOS 13.0, *) {
            if let statusBarManager = DMPUIManager.getCurrentWindow()?.windowScene?.statusBarManager
            {
                return statusBarManager.statusBarFrame.height
            }
        }
        return UIApplication.shared.statusBarFrame.height
    }

    public func getSafeAreaInsets() -> UIEdgeInsets {
        return DMPUIManager.getCurrentWindow()?.safeAreaInsets ?? .zero
    }

    public func getDeviceDisplayInfo() -> [String: Any] {
        let window = DMPUIManager.getCurrentWindow()
        let screen = window?.screen ?? UIScreen.main
        let screenBounds = screen.bounds
        let windowBounds = window?.bounds ?? screenBounds
        let screenScale = screen.scale

        let safeAreaInsets = getSafeAreaInsets()

        // windowWidth 与菜单按钮坐标必须使用同一个窗口坐标系；安全区域单独通过
        // safeArea 描述，不能从横向宽度中再次扣除，否则横屏会产生负的右侧间距。
        let windowWidth = windowBounds.width
        let windowHeight = max(windowBounds.height - safeAreaInsets.top - safeAreaInsets.bottom, 0)

        let statusBarHeight = getStatusBarHeight()

        let safeArea: [String: Any] = [
            "left": safeAreaInsets.left,
            "right": windowBounds.width - safeAreaInsets.right,
            "top": safeAreaInsets.top,
            "bottom": windowBounds.height - safeAreaInsets.bottom,
            "width": max(windowBounds.width - safeAreaInsets.left - safeAreaInsets.right, 0),
            "height": windowHeight,
        ]

        let displayInfo: [String: Any] = [
            "pixelRatio": screenScale,
            "screenWidth": screenBounds.width,
            "screenHeight": screenBounds.height,
            "screenScale": screenScale,
            "windowWidth": windowWidth,
            "windowHeight": windowHeight,
            "statusBarHeight": statusBarHeight,
            "screenTop": statusBarHeight,
            "safeArea": safeArea,
        ]

        return displayInfo
    }

    public func prepareUI() {
        _ = getStatusBarHeight()
        _ = getSafeAreaInsets()
        _ = getDeviceDisplayInfo()
    }

    public func clearCache() {
        // 动态窗口信息不再缓存。保留该方法兼容已有调用方。
    }

    // Function to get the current window
    public static func getCurrentWindow() -> UIWindow? {
        if #available(iOS 13.0, *) {
            // Get all connected scenes
            let connectedScenes = UIApplication.shared.connectedScenes
                .filter { $0.activationState == .foregroundActive }

            // First, try to get the foreground active scene
            if let windowScene = connectedScenes.first as? UIWindowScene {
                // Try to get the keyWindow
                if let keyWindow = windowScene.windows.first(where: { $0.isKeyWindow }) {
                    return keyWindow
                }
                // If there is no keyWindow, return the first window
                if let firstWindow = windowScene.windows.first {
                    return firstWindow
                }
            }

            // If there is no foreground active scene, try to get any available scene
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                let firstWindow = windowScene.windows.first
            {
                return firstWindow
            }

            return nil
        } else {
            // For versions before iOS 13
            return UIApplication.shared.keyWindow
        }
    }

    @MainActor
    public static func updateWindowStyle(isDarkTheme: Bool) {
        if let window = DMPUIManager.getCurrentWindow() {
            window.overrideUserInterfaceStyle = isDarkTheme ? .dark : .light
        }
    }

}
