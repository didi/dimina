//
// DMPPageOrientation.swift dimina
//

import UIKit

/// The single iOS model for pageOrientation parsing and UIKit mask mapping.
enum DMPPageOrientation: String, CaseIterable, Sendable {
    case portrait
    case auto
    case landscape

    static let defaultValue: DMPPageOrientation = .portrait

    static func parse(_ value: Any?) -> DMPPageOrientation? {
        guard let value = value as? String else { return nil }
        return DMPPageOrientation(rawValue: value)
    }

    /// Invalid values are absent values, so page config falls through to app config.
    static func resolve(pageValue: Any?, appValue: Any?) -> DMPPageOrientation {
        parse(pageValue) ?? parse(appValue) ?? defaultValue
    }

    var interfaceOrientations: UIInterfaceOrientationMask {
        switch self {
        case .portrait:
            return .portrait
        case .auto:
            return .allButUpsideDown
        case .landscape:
            return .landscape
        }
    }
}
