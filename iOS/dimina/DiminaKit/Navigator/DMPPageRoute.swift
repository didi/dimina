//
//  DMPPageRoute.swift
//  dimina
//

import Foundation

/// A mini-program route split into the page path used for resource lookup and
/// the query values delivered to the page.
public struct DMPPageRoute {
    public let pagePath: String
    public let query: [String: Any]

    public init(path: String) {
        let pathAndQuery = path.split(
            separator: "?",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        pagePath = String(pathAndQuery[0]).trimmingCharacters(in: .whitespacesAndNewlines)

        guard pathAndQuery.count == 2 else {
            query = [:]
            return
        }

        var parsedQuery: [String: Any] = [:]
        for parameter in pathAndQuery[1].split(
            separator: "&",
            omittingEmptySubsequences: false
        ) {
            guard !parameter.isEmpty else { continue }

            let keyAndValue = parameter.split(
                separator: "=",
                maxSplits: 1,
                omittingEmptySubsequences: false
            )
            let rawKey = String(keyAndValue[0]).trimmingCharacters(in: .whitespacesAndNewlines)
            let key = rawKey.removingPercentEncoding ?? rawKey
            guard !key.isEmpty else { continue }

            let rawValue = keyAndValue.count == 2
                ? String(keyAndValue[1]).trimmingCharacters(in: .whitespacesAndNewlines)
                : ""
            let value = rawValue.removingPercentEncoding ?? rawValue
            parsedQuery[key] = value
        }
        query = parsedQuery
    }

    public func merging(query overrides: [String: Any]?) -> [String: Any]? {
        var mergedQuery = query
        overrides?.forEach { mergedQuery[$0.key] = $0.value }
        return mergedQuery.isEmpty ? nil : mergedQuery
    }
}
