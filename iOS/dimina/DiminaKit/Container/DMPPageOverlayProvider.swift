//
//  DMPPageOverlayProvider.swift
//  dimina
//

import UIKit

/// Supplies host UI in place of the built-in page capsule.
public protocol DMPPageOverlayProvider: AnyObject {
    /// The returned view should provide an intrinsic content size or internal
    /// constraints that determine its width and height.
    func overlayView(for pageController: DMPPageController, isRoot: Bool) -> UIView?
}

/// Lets host-provided overlay UI follow `wx.setNavigationBarColor`.
public protocol DMPNavigationBarColorApplicable: AnyObject {
    func applyNavigationBarColor(frontColor: String, backgroundColor: String?)
}
