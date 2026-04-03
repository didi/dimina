//
//  NetworkTypeAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import Network
import CoreTelephony

/**
 * Device - Network API
 */
public class NetworkTypeAPI: DMPContainerApi {
    
    // API method names
    private static let GET_NETWORK_TYPE = "getNetworkType"
    
    // Get network type
    @BridgeMethod(GET_NETWORK_TYPE)
    var getNetworkType: DMPBridgeMethodHandler = { param, env, callback in
        // 获取网络类型
        let networkType = NetworkTypeAPI.getNetworkTypeInfo()
        
        let result = DMPMap()
        result.set("errMsg", "\(NetworkTypeAPI.GET_NETWORK_TYPE):ok")
        result.set("networkType", networkType)
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
    
    // Helper method to get network type
    private static func getNetworkTypeInfo() -> String {
        // 使用 NWPathMonitor 检查当前网络状态
        let monitor = NWPathMonitor()
        var networkType = "unknown"
        
        let semaphore = DispatchSemaphore(value: 0)
        
        monitor.pathUpdateHandler = { path in
            if path.usesInterfaceType(.wifi) {
                networkType = "wifi"
            } else if path.usesInterfaceType(.cellular) {
                // 对于蜂窝网络，需要进一步确定具体类型 (2g, 3g, 4g, 5g)
                networkType = getCellularNetworkType()
            } else if path.usesInterfaceType(.wiredEthernet) {
                // 有线网络归类为 wifi
                networkType = "wifi"
            } else if path.status == .satisfied {
                networkType = "unknown"
            } else {
                networkType = "none"
            }
            
            semaphore.signal()
        }
        
        let queue = DispatchQueue(label: "NetworkTypeMonitor")
        monitor.start(queue: queue)
        
        // 等待网络状态检查完成，最多等待1秒
        _ = semaphore.wait(timeout: .now() + 1.0)
        monitor.cancel()
        
        return networkType
    }
    
    // 获取蜂窝网络类型 (2g, 3g, 4g, 5g)
    private static func getCellularNetworkType() -> String {
        let networkInfo = CTTelephonyNetworkInfo()
        
        if #available(iOS 12.0, *) {
            // iOS 12及以上版本使用 serviceCurrentRadioAccessTechnology
            guard let carriers = networkInfo.serviceCurrentRadioAccessTechnology else {
                return "unknown"
            }
            
            // 获取第一个可用的网络技术
            guard let radioAccessTechnology = carriers.values.first else {
                return "unknown"
            }
            
            return self.mapRadioTechnologyToNetworkType(radioAccessTechnology)
        } else {
            // iOS 12以下版本使用 currentRadioAccessTechnology
            guard let radioAccessTechnology = networkInfo.currentRadioAccessTechnology else {
                return "unknown"
            }
            
            return self.mapRadioTechnologyToNetworkType(radioAccessTechnology)
        }
    }
    
    // 将无线电技术映射到网络类型
    private static func mapRadioTechnologyToNetworkType(_ radioTechnology: String) -> String {
        switch radioTechnology {
        // 2G 网络
        case CTRadioAccessTechnologyGPRS, CTRadioAccessTechnologyEdge, CTRadioAccessTechnologyCDMA1x:
            return "2g"
            
        // 3G 网络
        case CTRadioAccessTechnologyWCDMA, CTRadioAccessTechnologyHSDPA, CTRadioAccessTechnologyHSUPA, 
             CTRadioAccessTechnologyCDMAEVDORev0, CTRadioAccessTechnologyCDMAEVDORevA, CTRadioAccessTechnologyCDMAEVDORevB, 
             CTRadioAccessTechnologyeHRPD:
            return "3g"
            
        // 4G 网络
        case CTRadioAccessTechnologyLTE:
            return "4g"
            
        // 5G 网络 (iOS 14.1+)
        default:
            if #available(iOS 14.1, *) {
                if radioTechnology == CTRadioAccessTechnologyNRNSA || radioTechnology == CTRadioAccessTechnologyNR {
                    return "5g"
                }
            }
            return "unknown"
        }
    }
}
