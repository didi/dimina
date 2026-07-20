//
//  DMPPageCapsuleProvider.swift
//  dimina
//

import UIKit

/// Immutable page information and host actions exposed to a custom capsule.
public struct DMPPageCapsuleContext {
    public let appId: String
    public let appName: String
    public let pagePath: String
    public let query: [String: Any]
    public let isRoot: Bool
    public let close: () -> Void

    init(
        appId: String,
        appName: String,
        pagePath: String,
        query: [String: Any],
        isRoot: Bool,
        close: @escaping () -> Void
    ) {
        self.appId = appId
        self.appName = appName
        self.pagePath = pagePath
        self.query = query
        self.isRoot = isRoot
        self.close = close
    }
}

/// The current navigation bar appearance applied to a host-provided capsule.
public struct DMPPageCapsuleStyle {
    public let foregroundColor: UIColor
    public let backgroundColor: UIColor
    public let usesLightForeground: Bool

    init(
        foregroundColor: UIColor,
        backgroundColor: UIColor,
        usesLightForeground: Bool
    ) {
        self.foregroundColor = foregroundColor
        self.backgroundColor = backgroundColor
        self.usesLightForeground = usesLightForeground
    }
}

/// Supplies host UI in place of the built-in page capsule.
///
/// Dimina owns the capsule's position and size so that its native layout stays
/// consistent with `getMenuButtonBoundingClientRect`.
@MainActor
public protocol DMPPageCapsuleProvider: AnyObject {
    func makeCapsuleView(for context: DMPPageCapsuleContext) -> UIView?

    func updateCapsuleView(_ capsuleView: UIView, style: DMPPageCapsuleStyle)
}

public extension DMPPageCapsuleProvider {
    func updateCapsuleView(_ capsuleView: UIView, style: DMPPageCapsuleStyle) {}
}
