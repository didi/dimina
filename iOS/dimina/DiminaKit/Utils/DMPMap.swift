//
//  DMPMap.swift
//  dimina
//
//  Created by Lehem on 2025/4/21.
//

import Foundation

public class DMPMap: NSObject, NSCopying {
    private var dictionary: [String: Any] = [:]
    
    public override init() {
        super.init()
    }
    
    public init(_ dict: [String: Any]) {
        super.init()
        self.dictionary = dict
    }

    public init(_ dict: Any) {
        super.init()
        self.dictionary = dict as? [String: Any] ?? [:]
    }
    
    public func copy(with zone: NSZone? = nil) -> Any {
        let copy = DMPMap()
        copy.dictionary = self.dictionary
        return copy
    }

    public func merge(_ other: DMPMap) {
        let otherDict = other.toDictionary()
        for (key, value) in otherDict {
            self[key] = value
        }
    }
    
    public func set(_ key: String, _ value: Any) {
        dictionary[key] = value
    }
    
    public func get(_ key: String) -> Any? {
        return dictionary[key]
    }
    
    func getString(key: String) -> String? {
        return dictionary[key] as? String
    }
    
    func getInt(key: String) -> Int? {
        if let value = dictionary[key] as? Int {
            return value
        }
        if let value = dictionary[key] as? NSNumber {
            return value.intValue
        }
        if let value = dictionary[key] as? String {
            return Int(value)
        }
        return nil
    }
    
    func getBool(key: String) -> Bool? {
        if let value = dictionary[key] as? Bool {
            return value
        }
        if let value = dictionary[key] as? NSNumber {
            return value.boolValue
        }
        return nil
    }
    
    func getDMPMap(key: String) -> DMPMap? {
        if let dict = dictionary[key] as? [String: Any] {
            return DMPMap(dict)
        }
        return nil
    }
    
    func getDict(key: String) -> [String: Any]? {
        return dictionary[key] as? [String: Any]
    }
        
    func toJsonString() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dictionary, options: []) else {
            return "{}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    func toDictionary() -> [String: Any] {
        return dictionary
    }

    static func fromJsonString(json: String) -> DMPMap {
        let map = DMPMap()
        guard let data = json.data(using: .utf8),
              let jsonObject = try? JSONSerialization.jsonObject(with: data, options: []),
              let dictionary = jsonObject as? [String: Any] else {
            return map
        }
        map.dictionary = dictionary
        return map
    }

    static func fromDict(dict: [String: Any]) -> DMPMap {
        let map = DMPMap()
        map.dictionary = dict
        return map
    }

    static func fromDict(dict: Any) -> DMPMap {
        let map = DMPMap()
        map.dictionary = dict as? [String: Any] ?? [:]
        return map
    }

    // 添加下标赋值方法
    public subscript(key: String) -> Any? {
        get {
            return dictionary[key]
        }
        set {
            dictionary[key] = newValue
        }
    }

    public subscript<T>(key: String, as type: T.Type) -> T? {
        get {
            return dictionary[key] as? T
        }
        set {
            dictionary[key] = newValue
        }
    }

    func getDictionary(key: String) -> [String: Any]? {
        return dictionary[key] as? [String: Any]
    }
    
    func getDouble(key: String) -> Double? {
        if let doubleValue = dictionary[key] as? Double {
            return doubleValue
        }
        if let intValue = dictionary[key] as? Int {
            return Double(intValue)
        }
        if let stringValue = dictionary[key] as? String {
            return Double(stringValue)
        }
        return nil
    }

}
