//
//  StorageAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation

/**
 * Storage API implementation
 *
 * Handles data storage operations like setting, getting, and removing stored data
 */
public class StorageAPI: DMPContainerApi {
    
    // API method names
    private static let SET_STORAGE_SYNC = "setStorageSync"
    private static let GET_STORAGE_SYNC = "getStorageSync"
    private static let REMOVE_STORAGE_SYNC = "removeStorageSync"
    private static let CLEAR_STORAGE_SYNC = "clearStorageSync"
    private static let SET_STORAGE = "setStorage"
    private static let GET_STORAGE = "getStorage"
    private static let REMOVE_STORAGE = "removeStorage"
    private static let CLEAR_STORAGE = "clearStorage"
    private static let GET_STORAGE_INFO_SYNC = "getStorageInfoSync"
    private static let GET_STORAGE_INFO = "getStorageInfo"
    
    // 在类初始化时确保DMPStorage已初始化
    override public init(app: DMPApp? = nil) {
        super.init(app: app)
        DMPStorage.shared.initialize()
    }
    
    // wx.setStorageSync(key, data) → params: [key, data]
    @BridgeMethod(SET_STORAGE_SYNC)
    var setStorageSync: DMPBridgeMethodHandler = { param, env, callback in
        guard let array = param.getValue() as? [Any], array.count >= 2,
              let key = array[0] as? String else { return false }
        return DMPStorage.shared.set(key: key, value: array[1], encrypted: false)
    }

    // wx.getStorageSync(key) → params: key string
    @BridgeMethod(GET_STORAGE_SYNC)
    var getStorageSync: DMPBridgeMethodHandler = { param, env, callback in
        guard let key = param.getValue() as? String else { return nil }
        guard let value = DMPStorage.shared.get(key: key, encrypted: false) else { return nil }
        return DMPBridgeParam(value: value)
    }

    // wx.removeStorageSync(key) → params: [key]
    @BridgeMethod(REMOVE_STORAGE_SYNC)
    var removeStorageSync: DMPBridgeMethodHandler = { param, env, callback in
        guard let array = param.getValue() as? [Any],
              let key = array.first as? String else { return false }
        DMPStorage.shared.remove(key: key, encrypted: false)
        return true
    }
    
    // Clear storage synchronously
    @BridgeMethod(CLEAR_STORAGE_SYNC)
    var clearStorageSync: DMPBridgeMethodHandler = { param, env, callback in
        // 清除所有存储（包括加密和非加密）
        DMPStorage.shared.clearAllStorage()
        return true
    }
    
    // Set storage
    @BridgeMethod(SET_STORAGE)
    var setStorage: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let key = param.get("key") as? String else {
            let errMsg = "\(SET_STORAGE):fail missing parameter key"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            return nil
        }
        
        let data = param.get("data")
        let encrypt = param.get("encrypt") as? Bool ?? false
        
        guard let data = data else {
            let errMsg = "\(SET_STORAGE):fail missing parameter data"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            return nil
        }
        
        // 在后台线程执行存储操作
        DispatchQueue.global().async {
            let success = DMPStorage.shared.set(key: key, value: data, encrypted: encrypt)
            
            DispatchQueue.main.async {
                if success {
                    let resultMap = DMPMap()
                    resultMap.set("errMsg", "\(SET_STORAGE):ok")
                    DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
                } else {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(SET_STORAGE):fail")
                }
            }
        }
        
        return nil
    }
    
    // Get storage
    @BridgeMethod(GET_STORAGE)
    var getStorage: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let key = param.get("key") as? String else {
            let errMsg = "\(GET_STORAGE):fail missing parameter key"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            return nil
        }
        
        let encrypt = param.get("encrypt") as? Bool ?? false
        
        // 在后台线程执行获取操作
        DispatchQueue.global().async {
            let value = DMPStorage.shared.get(key: key, encrypted: encrypt)
            
            DispatchQueue.main.async {
                if let value = value {
                    let resultMap = DMPMap()
                    resultMap.set("data", value)
                    resultMap.set("errMsg", "\(GET_STORAGE):ok")
                    DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
                } else {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(GET_STORAGE):fail data not found")
                }
            }
        }
        
        return nil
    }
    
    // Remove storage
    @BridgeMethod(REMOVE_STORAGE)
    var removeStorage: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let key = param.get("key") as? String else {
            let errMsg = "\(REMOVE_STORAGE):fail missing parameter key"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            return nil
        }
        
        let encrypt = param.get("encrypt") as? Bool ?? false
        
        // 在后台线程执行删除操作
        DispatchQueue.global().async {
            DMPStorage.shared.remove(key: key, encrypted: encrypt)
            
            DispatchQueue.main.async {
                let resultMap = DMPMap()
                resultMap.set("errMsg", "\(REMOVE_STORAGE):ok")
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            }
        }
        
        return nil
    }
    
    // Clear storage
    @BridgeMethod(CLEAR_STORAGE)
    var clearStorage: DMPBridgeMethodHandler = { param, env, callback in
        // 在后台线程执行清除操作
        DispatchQueue.global().async {
            DMPStorage.shared.clearAllStorage()
            
            DispatchQueue.main.async {
                let resultMap = DMPMap()
                resultMap.set("errMsg", "\(CLEAR_STORAGE):ok")
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            }
        }
        
        return nil
    }
    
    // Get storage info synchronously
    @BridgeMethod(GET_STORAGE_INFO_SYNC)
    var getStorageInfoSync: DMPBridgeMethodHandler = { param, env, callback in
        let storageInfo = DMPStorage.shared.getAllStorageInfo()
        
        let result = DMPMap()
        result.set("keys", storageInfo.keys)
        result.set("currentSize", storageInfo.currentSize)
        result.set("limitSize", storageInfo.limitSize)
        
        return result
    }
    
    // Get storage info
    @BridgeMethod(GET_STORAGE_INFO)
    var getStorageInfo: DMPBridgeMethodHandler = { param, env, callback in
        // 在后台线程执行获取存储信息操作
        DispatchQueue.global().async {
            let storageInfo = DMPStorage.shared.getAllStorageInfo()
            
            DispatchQueue.main.async {
                let resultMap = DMPMap()
                resultMap.set("keys", storageInfo.keys)
                resultMap.set("currentSize", storageInfo.currentSize)
                resultMap.set("limitSize", storageInfo.limitSize)
                resultMap.set("errMsg", "\(GET_STORAGE_INFO):ok")
                
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            }
        }
        
        return nil
    }
}
