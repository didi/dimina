//
//  NetworkAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import Alamofire

/**
 * Network API implementation
 * Provides bridge methods for network operations compatible with WeChat Mini Program API
 * Handles HTTP requests, file downloads, and file uploads
 * Uses DMPNetwork for underlying network operations
 */
public class NetworkAPI: DMPContainerApi {
    
    // API method names
    private static let REQUEST = "request"
    private static let DOWNLOAD_FILE = "downloadFile"
    private static let UPLOAD = "uploadFile"
    
    /**
     * Bridge method for HTTP request
     * Mimics wx.request API from WeChat Mini Program
     * Supports various HTTP methods, headers, and data types
     */
    @BridgeMethod(REQUEST)
    var request: DMPBridgeMethodHandler = { param, env, callback in
        // 获取请求参数
        let param = param.getMap()
        let url = param.getString(key: "url") ?? ""
        let data = param.get("data")
        let headerDict = param.getDictionary(key: "header")
        let timeout = param.getDouble(key: "timeout") ?? 60000
        let methodStr = param.getString(key: "method")?.uppercased() ?? "GET"
        let dataType = param.getString(key: "dataType") ?? "json"
        
        // 验证URL
        guard let _ = URL(string: url) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "request:fail invalid url")
            return DMPAsyncResult()
        }
        
        // 转换header
        var header: [String: String]?
        if let headerDict = headerDict {
            header = headerDict.reduce(into: [String: String]()) { (result, keyValue) in
                if let key = keyValue.key as? String, 
                   let value = keyValue.value as? String {
                    result[key] = value
                }
            }
        }
        
        // 转换HTTP方法
        let method = HTTPMethod(rawValue: methodStr)
        
        // 发起网络请求
        DMPNetwork.shared.request(
            url: url,
            method: method,
            data: data,
            header: header,
            timeout: timeout / 1000, // 转换为秒
            dataType: dataType,
            success: { (responseData, statusCode, responseHeaders, cookies) in
                let resultMap = DMPMap()
                
                // 处理响应数据
                if let data = responseData {
                    if dataType.lowercased() == "json" {
                        do {
                            // 尝试解析JSON
                            let jsonObject = try JSONSerialization.jsonObject(with: data)
                            resultMap.set("data", jsonObject)
                        } catch {
                            // JSON解析失败，返回字符串
                            let dataString = String(data: data, encoding: .utf8) ?? ""
                            resultMap.set("data", dataString)
                        }
                    } else {
                        // 非JSON格式，直接返回字符串
                        let dataString = String(data: data, encoding: .utf8) ?? ""
                        resultMap.set("data", dataString)
                    }
                }
                
                // 设置响应状态码
                resultMap.set("statusCode", statusCode)
                
                // 设置响应头
                resultMap.set("header", responseHeaders)
                
                // 设置Cookies
                if !cookies.isEmpty {
                    resultMap.set("cookies", cookies)
                }
                
                // 返回成功结果
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            },
            fail: { (errMsg, errno) in
                // 构建错误信息
                let errorMap = DMPMap()
                errorMap.set("errMsg", errMsg)
                
                // 设置错误码（如果有）
                if let errno = errno {
                    errorMap.set("errno", errno)
                }
                
                // 返回失败结果
                DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: errMsg)
            },
            complete: {
                // 完成回调
                DMPContainerApi.invokeCallback(callback, type: .complete, param: nil)
            }
        )
        
        return DMPAsyncResult()
    }

    /**
     * Bridge method for file download
     * Mimics wx.downloadFile API from WeChat Mini Program
     * Supports custom file paths and headers
     */
    @BridgeMethod(DOWNLOAD_FILE)
    var downloadFile: DMPBridgeMethodHandler = { param, env, callback in
        // 获取下载参数
        let param = param.getMap()
        let url = param.getString(key: "url") ?? ""
        let headerDict = param.getDictionary(key: "header")
        let timeout = param.getDouble(key: "timeout") ?? 60000
        let filePath = param.getString(key: "filePath")
        
        // 验证URL
        guard let _ = URL(string: url) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "downloadFile:fail invalid url")
            return DMPAsyncResult()
        }
        
        // 转换header
        var header: [String: String]?
        if let headerDict = headerDict {
            header = headerDict.reduce(into: [String: String]()) { (result, keyValue) in
                if let key = keyValue.key as? String, 
                   let value = keyValue.value as? String {
                    result[key] = value
                }
            }
        }
        
        // 发起文件下载
        DMPNetwork.shared.downloadFile(
            url: url,
            header: header,
            timeout: timeout / 1000, // 转换为秒
            filePath: filePath,
            success: { (savedPath, statusCode) in
                let resultMap = DMPMap()
                
                // 如果指定了文件路径，则返回filePath，否则返回tempFilePath
                if filePath != nil {
                    resultMap.set("filePath", savedPath)
                } else {
                    resultMap.set("tempFilePath", savedPath)
                }
                
                // 设置响应状态码
                resultMap.set("statusCode", statusCode)
                
                // 返回成功结果
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            },
            fail: { (errMsg) in
                // 返回失败结果
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            },
            complete: {
                // 完成回调
                DMPContainerApi.invokeCallback(callback, type: .complete, param: nil)
            }
        )
        
        return DMPAsyncResult()
    }

    /**
     * Bridge method for file upload
     * Mimics wx.uploadFile API from WeChat Mini Program
     * Supports multipart form data and additional form fields
     */
    @BridgeMethod(UPLOAD)
    var uploadFile: DMPBridgeMethodHandler = { param, env, callback in
        // 获取上传参数
        let param = param.getMap()
        let url = param.getString(key: "url") ?? ""
        let filePath = param.getString(key: "filePath") ?? ""
        let name = param.getString(key: "name") ?? ""
        let headerDict = param.getDictionary(key: "header")
        let formDataDict = param.getDictionary(key: "formData")
        let timeout = param.getDouble(key: "timeout") ?? 60000
        
        // 验证必要参数
        if url.isEmpty || filePath.isEmpty || name.isEmpty {
            let errMsg = "uploadFile:fail missing required parameters"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            return DMPAsyncResult()
        }

        // 验证URL
        guard let _ = URL(string: url) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "uploadFile:fail invalid url")
            return DMPAsyncResult()
        }

        // 验证文件路径
        if !FileManager.default.fileExists(atPath: filePath) {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "uploadFile:fail file does not exist")
            return DMPAsyncResult()
        }
        
        // 转换header
        var header: [String: String]?
        if let headerDict = headerDict {
            header = headerDict.reduce(into: [String: String]()) { (result, keyValue) in
                if let key = keyValue.key as? String, 
                   let value = keyValue.value as? String {
                    result[key] = value
                }
            }
        }
        
        // 转换formData
        var formData: [String: Any]?
        if let formDataDict = formDataDict {
            formData = formDataDict.reduce(into: [String: Any]()) { (result, keyValue) in
                if let key = keyValue.key as? String {
                    result[key] = keyValue.value
                }
            }
        }
        
        // 发起文件上传
        DMPNetwork.shared.uploadFile(
            url: url,
            filePath: filePath,
            name: name,
            header: header,
            formData: formData,
            timeout: timeout / 1000, // 转换为秒
            success: { (responseData, statusCode) in
                let resultMap = DMPMap()
                
                // 设置响应数据
                resultMap.set("data", responseData)
                
                // 设置响应状态码
                resultMap.set("statusCode", statusCode)
                
                // 返回成功结果
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
            },
            fail: { (errMsg) in
                // 返回失败结果
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg)
            },
            complete: {
                // 完成回调
                DMPContainerApi.invokeCallback(callback, type: .complete, param: nil)
            }
        )
        
        return DMPAsyncResult()
    }
}
