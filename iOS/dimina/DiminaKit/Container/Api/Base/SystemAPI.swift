//
//  SystemAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit
import CoreBluetooth
import CoreLocation

/**
 * System API implementation
 *
 * Handles system-related operations like getting device information
 */
public class SystemAPI: DMPContainerApi {
    
    // API method names
    private static let GET_WINDOW_INFO = "getWindowInfo"
    private static let GET_SYSTEM_SETTING = "getSystemSetting"
    private static let GET_SYSTEM_INFO_SYNC = "getSystemInfoSync"
    private static let GET_SYSTEM_INFO_ASYNC = "getSystemInfoAsync"
    private static let GET_SYSTEM_INFO = "getSystemInfo"
    
    // Get window information
    @BridgeMethod(GET_WINDOW_INFO)
    var getWindowInfo: DMPBridgeMethodHandler = { param, env, callback in
        let windowInfo = DMPMap(DMPUIManager.shared.getDeviceDisplayInfo())
        return DMPSyncResult(windowInfo.toDictionary())
    }

    // Get system settings
    @BridgeMethod(GET_SYSTEM_SETTING)
    var getSystemSetting: DMPBridgeMethodHandler = { param, env, callback in
        let result = DMPMap()

        // 蓝牙开关状态
        let bluetoothEnabled: Bool
        if #available(iOS 10.0, *) {
            bluetoothEnabled = CBCentralManager().state == .poweredOn
        } else {
            // 对于低版本 iOS，可能需要其他方式检测
            bluetoothEnabled = false
        }

        // 地理位置开关状态
        let locationEnabled: Bool
        let locationManager = CLLocationManager()
        let status = locationManager.authorizationStatus

        if #available(iOS 14.0, *) {
            locationEnabled = status != .denied
        } else {
            locationEnabled = status != .restricted && status != .denied
        }

        // Wi-Fi 开关状态（iOS 无法直接获取）
        let wifiEnabled = false

        // 设备方向
        let deviceOrientation: String
        let orientation = UIDevice.current.orientation
        switch orientation {
        case .landscapeLeft, .landscapeRight:
            deviceOrientation = "landscape"
        case .portrait, .portraitUpsideDown:
            deviceOrientation = "portrait"
        default:
            // 默认为竖屏
            deviceOrientation = "portrait"
        }

        // 填充结果
        result["bluetoothEnabled"] = bluetoothEnabled
        result["locationEnabled"] = locationEnabled
        result["wifiEnabled"] = wifiEnabled
        result["deviceOrientation"] = deviceOrientation

        return DMPSyncResult(result.toDictionary())
    }

    // Get system information synchronously
    @BridgeMethod(GET_SYSTEM_INFO_SYNC)
    var getSystemInfoSync: DMPBridgeMethodHandler = { param, env, callback in
        let systemInfo = SystemAPI.getSystemInfo()
        return DMPSyncResult(systemInfo.toDictionary())
    }

    // Get system information asynchronously
    @BridgeMethod(GET_SYSTEM_INFO_ASYNC)
    var getSystemInfoAsync: DMPBridgeMethodHandler = { param, env, callback in
        let systemInfo = SystemAPI.getSystemInfo()
        DMPContainerApi.invokeSuccess(callback: callback, param: systemInfo)
        return DMPAsyncResult()
    }

    // Get system information
    @BridgeMethod(GET_SYSTEM_INFO)
    var getSystemInfo: DMPBridgeMethodHandler = { param, env, callback in
        let systemInfo = SystemAPI.getSystemInfo()
        DMPContainerApi.invokeSuccess(callback: callback, param: systemInfo)
        return DMPSyncResult(systemInfo.toDictionary())
    }

    static func getSystemInfo() -> DMPMap {
        let displayInfo = DMPMap(DMPUIManager.shared.getDeviceDisplayInfo())
        
        let systemInfo = DMPMap([
            "brand": UIDevice.current.model,
            "model": UIDevice.current.model,
            
            "language": Locale.current.languageCode ?? "zh_CN",
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "system": UIDevice.current.systemName + " " + UIDevice.current.systemVersion,
            "platform": "ios",
            "SDKVersion": DiminaVersion.sdkVersion,
            
            "albumAuthorized": false,
            "cameraAuthorized": false,
            "locationAuthorized": false,
            "microphoneAuthorized": false,
            
            "theme": UITraitCollection.current.userInterfaceStyle == .dark ? "dark" : "light",
        ])
        
        // 合并显示信息
        systemInfo.merge(displayInfo)
        return systemInfo
    }
}
