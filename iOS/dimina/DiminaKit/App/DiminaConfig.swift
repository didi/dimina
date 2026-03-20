//
//  DiminaConfig.swift
//  dimina
//

import Foundation

public class DiminaConfig {
    public static let shared = DiminaConfig()

    public var apiNamespaces: [String] = []

    private init() {}
}
