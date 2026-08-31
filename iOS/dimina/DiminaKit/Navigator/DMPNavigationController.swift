//
// DMPNavigationController.swift dimina
//

import UIKit

/// Marker contract for a host-owned navigation controller that forwards the orientation queries below to its visible mini-program controller.
/// Hosts that already own a `UINavigationController` subclass can conform after implementing the same three forwarding overrides as `DMPNavigationController`.
public protocol DMPPageOrientationForwarding: AnyObject {}

public enum DMPPageOrientationSupport: Equatable, Sendable {
    case notConfigured
    case disabled
    case supported
    case unsupportedNavigationController
}

/// `UINavigationController` does not forward `supportedInterfaceOrientations` / `shouldAutorotate` / `preferredInterfaceOrientationForPresentation` to its `topViewController` by default — only the root/consulted view controller in a window is asked.
/// Without this forwarding, a page's own orientation lock (`pageOrientation` config) has no effect no matter what `DMPPageController` returns.
/// Hosts that want per-page orientation locking use `DMPNavigator.setup(navigationController:)` with an instance of this class.
/// A host that must retain its own navigation subclass implements the same overrides and explicitly conforms to `DMPPageOrientationForwarding`.
public class DMPNavigationController: UINavigationController, DMPPageOrientationForwarding {
    public override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        topViewController?.supportedInterfaceOrientations ?? super.supportedInterfaceOrientations
    }

    public override var shouldAutorotate: Bool {
        topViewController?.shouldAutorotate ?? super.shouldAutorotate
    }

    public override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        topViewController?.preferredInterfaceOrientationForPresentation
            ?? super.preferredInterfaceOrientationForPresentation
    }
}
