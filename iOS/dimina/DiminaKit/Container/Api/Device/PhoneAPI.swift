//
//  PhoneAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * Device - Phone API
 */
public class PhoneAPI: DMPContainerApi {
    
    // API method names
    private static let MAKE_PHONE_CALL = "makePhoneCall"
    
    // Make phone call
    @BridgeMethod(MAKE_PHONE_CALL)
    var makePhoneCall: DMPBridgeMethodHandler = { param, env, callback in
        // 获取电话号码
        let phoneNumber = param.getMap().get("phoneNumber") as? String ?? ""
        
        // 检查电话号码是否为空
        if phoneNumber.isEmpty {
            let result = DMPMap()
            result.set("errMsg", "\(PhoneAPI.MAKE_PHONE_CALL):fail phoneNumber is required")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "phoneNumber is required")
            return DMPAsyncResult()
        }

        // 构建电话 URL
        guard let url = URL(string: "tel:\(phoneNumber)") else {
            let result = DMPMap()
            result.set("errMsg", "\(PhoneAPI.MAKE_PHONE_CALL):fail invalid phone number")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "invalid phone number")
            return DMPAsyncResult()
        }

        // 检查设备是否支持拨号
        guard UIApplication.shared.canOpenURL(url) else {
            let result = DMPMap()
            result.set("errMsg", "\(PhoneAPI.MAKE_PHONE_CALL):fail device does not support phone calls")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "device does not support phone calls")
            return DMPAsyncResult()
        }

        // 在主线程上打开 URL
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { success in
                let result = DMPMap()
                if success {
                    result.set("errMsg", "\(PhoneAPI.MAKE_PHONE_CALL):ok")
                    DMPContainerApi.invokeSuccess(callback: callback, param: result)
                } else {
                    result.set("errMsg", "\(PhoneAPI.MAKE_PHONE_CALL):fail unable to make phone call")
                    DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "unable to make phone call")
                }
            }
        }
        return DMPAsyncResult()
    }
}
