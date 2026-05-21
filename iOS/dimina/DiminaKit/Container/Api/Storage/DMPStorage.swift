//
//  DMPStorage.swift
//  dimina
//
//  Created by Lehem on 2025/5/13.
//

import Foundation
import MMKV
import UIKit

/**
 * Wrapper utility class for MMKV
 * Provides thread-safe storage capabilities
 * Supports all functionalities required by Mini Program Storage API
 */
public class DMPStorage {
    // Singleton pattern
    public static let shared = DMPStorage()
    
    // Queue for synchronizing cross-thread access
    private let queue = DispatchQueue(label: "com.dimina.mmkv.queue", attributes: .concurrent)
    
    // MMKV instance
    private var mmkv: MMKV?
    
    // Encrypted MMKV instance
    private var encryptedMMKV: MMKV?
    
    // Initialization status
    private var isInitialized = false
    
    // Private initialization method
    private init() {}
    
    // Initialize MMKV
    public func initialize(appId: String? = nil) {
        if isInitialized {
            return
        }
        
        queue.sync(flags: .barrier) {
            if !self.isInitialized {
                // Initialize MMKV with default root directory
                MMKV.initialize(rootDir: nil)
                
                // Create MMKV instance with app-specific ID
                let mmapID = appId != nil ? "com.dimina.storage.\(appId!)" : "com.dimina.storage.default"
                mmkv = MMKV(mmapID: mmapID)
                
                // Initialize encrypted MMKV instance with a fixed key
                // In actual applications, a more secure key management approach should be used
                let cryptKey = "DiminaEncryptKey"
                // Convert string to Data type
                if let cryptKeyData = cryptKey.data(using: .utf8) {
                    let encryptedMmapID = appId != nil ? "com.dimina.storage.encrypted.\(appId!)" : "com.dimina.storage.encrypted.default"
                    encryptedMMKV = MMKV(mmapID: encryptedMmapID, cryptKey: cryptKeyData)
                }
                
                self.isInitialized = true
                print("DMPStorage: Initialization successful for \(appId ?? "default")")
            }
        }
    }
    
    // Module initialization, should be called during app startup
    public static func setupModule(appId: String? = nil) {
        // Register notification to clean up resources when the app exits
        NotificationCenter.default.addObserver(
            shared, 
            selector: #selector(appWillTerminate), 
            name: UIApplication.willTerminateNotification, 
            object: nil
        )
        
        // Initialize MMKV with app-specific ID
        shared.initialize(appId: appId)
    }
    
    // Module destruction, should be called when the app exits
    public static func teardownModule() {
        // Remove notification listener
        NotificationCenter.default.removeObserver(shared)
        
        // Destroy MMKV instances
        shared.destroy()
    }
    
    // App termination notification handler
    @objc private func appWillTerminate() {
        DMPStorage.teardownModule()
    }
    
    // Get MMKV instance
    public func getInstance(encrypted: Bool = false) -> MMKV? {
        if mmkv == nil {
            initialize()  // This is valid because appId has a default value of nil
        }
        return encrypted ? encryptedMMKV : mmkv
    }
    
    // Set value
    public func set(key: String, value: Any, encrypted: Bool = false) -> Bool {
        var result = false
        queue.sync(flags: .barrier) {
            guard let mmkv = getInstance(encrypted: encrypted) else { return }
            
            do {
                // 创建存储字典，包含值和类型
                var storageDict: [String: Any] = [
                    "dmpvalue": value
                ]
                
                // 确定并存储值的类型
                switch value {
                case is String:
                    storageDict["type"] = "String"
                case is Bool:
                    storageDict["type"] = "Bool"
                case is Int:
                    storageDict["type"] = "Int"
                case is Int32:
                    storageDict["type"] = "Int32"
                case is Double:
                    storageDict["type"] = "Double"
                case is Float:
                    storageDict["type"] = "Float"
                case is Data:
                    storageDict["type"] = "Data"
                case is [String: Any]:
                    storageDict["type"] = "Dictionary"
                case is [Any]:
                    storageDict["type"] = "Array"
                default:
                    storageDict["type"] = "Unknown"
                }
                
                // 将字典转换为 Data
                let data = try JSONSerialization.data(withJSONObject: storageDict, options: [])
                result = mmkv.set(data, forKey: key)
            } catch {
                // 如果序列化失败，尝试将值转换为字符串存储
                let stringValue = String(describing: value)
                let storageDict: [String: Any] = [
                    "dmpvalue": stringValue,
                    "type": "String"
                ]
                
                do {
                    let data = try JSONSerialization.data(withJSONObject: storageDict, options: [])
                    result = mmkv.set(data, forKey: key)
                } catch {
                    print("DMPStorage: Failed to store value for key \(key)")
                }
            }
        }
        return result
    }
    
    // Get value
    public func get(key: String, encrypted: Bool = false) -> Any? {
        var result: Any?
        queue.sync {
            guard let mmkv = getInstance(encrypted: encrypted) else { return }
            
            // 检查 key 是否存在
            guard let data = mmkv.data(forKey: key) else { return }
            
            do {
                // 解析存储的字典
                if let storageDict = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let value = storageDict["dmpvalue"],
                   let type = storageDict["type"] as? String {
                    
                    // 根据存储的类型返回相应的值
                    switch type {
                    case "String":
                        result = value as? String
                    case "Bool":
                        result = value as? Bool
                    case "Int":
                        result = value as? Int
                    case "Int32":
                        result = value as? Int32
                    case "Double":
                        result = value as? Double
                    case "Float":
                        result = value as? Float
                    case "Data":
                        result = value as? Data
                    case "Dictionary":
                        result = value as? [String: Any]
                    case "Array":
                        result = value as? [Any]
                    default:
                        result = value
                    }
                }
            } catch {
                print("DMPStorage: Failed to retrieve value for key \(key)")
            }
        }
        
        return result
    }
    
    // Delete key
    public func remove(key: String, encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            getInstance(encrypted: encrypted)?.removeValue(forKey: key)
        }
    }
    
    // Delete multiple keys
    public func removeMultiple(keys: [String], encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            getInstance(encrypted: encrypted)?.removeValues(forKeys: keys)
        }
    }
    
    // Clear all data
    public func clearAll(encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            if encrypted {
                encryptedMMKV?.clearAll()
            } else {
                mmkv?.clearAll()
            }
        }
    }
    
    // Clear all data (including encrypted and non-encrypted)
    public func clearAllStorage() {
        queue.sync(flags: .barrier) {
            mmkv?.clearAll()
            encryptedMMKV?.clearAll()
        }
    }
    
    // Check if key exists
    public func contains(key: String, encrypted: Bool = false) -> Bool {
        var result = false
        queue.sync {
            result = getInstance(encrypted: encrypted)?.contains(key: key) ?? false
        }
        return result
    }
    
    // Get all keys
    public func getAllKeys(encrypted: Bool = false) -> [String] {
        var result: [String] = []
        queue.sync {
            // Use type conversion to ensure return type is [String]
            if let keys = getInstance(encrypted: encrypted)?.allKeys() as? [String] {
                result = keys
            }
        }
        return result
    }
    
    // Get storage information
    public func getStorageInfo(encrypted: Bool = false) -> (keys: [String], currentSize: Int, limitSize: Int) {
        var keys: [String] = []
        var size: Int = 0
        
        queue.sync {
            guard let mmkv = getInstance(encrypted: encrypted) else { return }
            // Use type conversion to ensure return type is [String]
            if let allKeys = mmkv.allKeys() as? [String] {
                keys = allKeys
            }
            size = mmkv.totalSize() / 1024  // Convert to KB
        }
        
        // MMKV limit is approximately 10MB
        return (keys: keys, currentSize: size, limitSize: 10 * 1024)  // 10MB converted to KB
    }
    
    // Get all storage information (including encrypted and non-encrypted)
    public func getAllStorageInfo() -> (keys: [String], currentSize: Int, limitSize: Int) {
        var normalKeys: [String] = []
        var encryptedKeys: [String] = []
        var normalSize: Int = 0
        var encryptedSize: Int = 0
        
        queue.sync {
            // Use type conversion to ensure return type is [String]
            if let keys = mmkv?.allKeys() as? [String] {
                normalKeys = keys
            }
            if let keys = encryptedMMKV?.allKeys() as? [String] {
                encryptedKeys = keys
            }
            normalSize = mmkv?.totalSize() ?? 0
            encryptedSize = encryptedMMKV?.totalSize() ?? 0
        }
        
        // Merge keys and remove duplicates
        let allKeys = Array(Set(normalKeys + encryptedKeys))
        let totalSize = (normalSize + encryptedSize) / 1024  // Convert to KB
        
        // MMKV limit is approximately 10MB
        return (keys: allKeys, currentSize: totalSize, limitSize: 10 * 1024)  // 10MB converted to KB
    }
    
    // Destroy instances
    public func destroy() {
        queue.sync(flags: .barrier) {
            mmkv = nil
            encryptedMMKV = nil
            isInitialized = false
            print("DMPStorage: Destroyed")
        }
    }
}
