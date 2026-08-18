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
    private static let ABORT_UPLOAD = "uploadFileTaskAbort"

    private struct UploadTaskKey: Hashable {
        let appId: String
        let taskId: String
    }

    private struct UploadTaskEntry {
        let ownerToken: UUID
        var request: UploadRequest?
    }

    private static let uploadTaskLock = NSLock()
    private static var uploadTasks: [UploadTaskKey: UploadTaskEntry] = [:]
    
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
        let taskId = param.getString(key: "taskId") ?? UUID().uuidString
        let progressCallbackId = param.getString(key: "progressCallback") ?? ""
        let headersCallbackId = param.getString(key: "headersCallback") ?? ""
        let headerDict = param.getDictionary(key: "header")
        let formDataDict = param.getDictionary(key: "formData")
        let requestedTimeout = param.getDouble(key: "timeout") ?? 60000
        let timeout = requestedTimeout > 0 ? requestedTimeout : 60000
        
        // 验证必要参数
        if url.isEmpty || filePath.isEmpty || name.isEmpty {
            let errMsg = "uploadFile:fail missing required parameters"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg,
                                          completeCarriesResult: true)
            return DMPAsyncResult()
        }

        // 验证URL
        guard let parsedURL = URL(string: url),
              let scheme = parsedURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil,
                                          errMsg: "uploadFile:fail invalid url",
                                          completeCarriesResult: true)
            return DMPAsyncResult()
        }

        // chooseImage 等文件 API 返回 difile:// 虚拟路径，上传前解析到当前小程序沙箱。
        let resolvedFilePath = DMPFileUtil.sandboxPathFromVPath(from: filePath, appId: env.appId) ?? filePath
        var isDirectory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: resolvedFilePath, isDirectory: &isDirectory)
            || isDirectory.boolValue {
            DMPContainerApi.invokeFailure(callback: callback, param: nil,
                                          errMsg: "uploadFile:fail file does not exist",
                                          completeCarriesResult: true)
            return DMPAsyncResult()
        }
        
        // 转换header
        var header: [String: String]?
        if let headerDict = headerDict {
            header = headerDict.reduce(into: [String: String]()) { (result, keyValue) in
                result[keyValue.key] = String(describing: keyValue.value)
            }
        }
        
        // 转换formData
        var formData: [String: Any]?
        if let formDataDict = formDataDict {
            formData = formDataDict.reduce(into: [String: Any]()) { (result, keyValue) in
                result[keyValue.key] = String(describing: keyValue.value)
            }
        }
        
        // Upload progress/header events bypass the normal container callback,
        // so bind them to this runtime-owned task token. Restart/exit removes
        // the token before a new service is installed and late events drop.
        let ownerToken = NetworkAPI.activateUploadTask(appId: env.appId, taskId: taskId)

        // 发起文件上传
        let uploadRequest = DMPNetwork.shared.uploadFile(
            url: url,
            filePath: resolvedFilePath,
            name: name,
            header: header,
            formData: formData,
            timeout: timeout / 1000, // 转换为秒
            progress: { completedBytes, totalBytes in
                NetworkAPI.pushUploadEvent(
                    appId: env.appId,
                    taskId: taskId,
                    ownerToken: ownerToken,
                    callbackId: progressCallbackId,
                    payload: NetworkAPI.uploadProgressPayload(
                        completedBytes: completedBytes,
                        totalBytes: totalBytes
                    )
                )
            },
            headersReceived: { responseHeaders in
                NetworkAPI.pushUploadEvent(
                    appId: env.appId,
                    taskId: taskId,
                    ownerToken: ownerToken,
                    callbackId: headersCallbackId,
                    payload: DMPMap(["header": responseHeaders])
                )
            },
            success: { (responseData, statusCode) in
                NetworkAPI.removeUploadTask(
                    appId: env.appId,
                    taskId: taskId,
                    ownerToken: ownerToken
                )
                let resultMap = DMPMap()
                
                // 设置响应数据
                resultMap.set("data", responseData)
                
                // 设置响应状态码
                resultMap.set("statusCode", statusCode)
                resultMap.set("errMsg", "uploadFile:ok")
                
                // 返回成功结果
                DMPContainerApi.invokeSuccess(callback: callback, param: resultMap,
                                              completeCarriesResult: true)
            },
            fail: { (errMsg) in
                NetworkAPI.removeUploadTask(
                    appId: env.appId,
                    taskId: taskId,
                    ownerToken: ownerToken
                )
                // 返回失败结果
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errMsg,
                                              completeCarriesResult: true)
            }
        )
        NetworkAPI.storeUploadTask(
            uploadRequest,
            appId: env.appId,
            taskId: taskId,
            ownerToken: ownerToken
        )
        
        return DMPAsyncResult()
    }

    @BridgeMethod(ABORT_UPLOAD)
    var abortUploadFile: DMPBridgeMethodHandler = { param, env, _ in
        let taskId = param.getMap().getString(key: "taskId") ?? ""
        if !taskId.isEmpty {
            NetworkAPI.abortUploadTask(appId: env.appId, taskId: taskId)
        }
        return DMPNoneResult()
    }

    private static func uploadProgressPayload(completedBytes: Int64, totalBytes: Int64) -> DMPMap {
        let sent = max(completedBytes, 0)
        let total = max(totalBytes, 0)
        let percentage: Int
        if total > 0 {
            percentage = min(max(Int((Double(sent) / Double(total)) * 100), 0), 100)
        } else {
            percentage = 0
        }
        return DMPMap([
            "progress": percentage,
            "totalBytesSent": sent,
            "totalBytesExpectedToSend": total,
        ])
    }

    private static func pushUploadEvent(
        appId: String,
        taskId: String,
        ownerToken: UUID,
        callbackId: String,
        payload: DMPMap
    ) {
        guard !callbackId.isEmpty,
              isUploadTaskActive(appId: appId, taskId: taskId, ownerToken: ownerToken),
              let app = DMPAppManager.sharedInstance().existApp(appId: appId) else { return }
        let message = DMPMap([
            "type": "triggerCallback",
            "body": ["id": callbackId, "args": payload.toDictionary()],
        ])
        DMPChannelProxy.containerToService(msg: message, app: app)
    }

    static func activateUploadTask(appId: String, taskId: String) -> UUID {
        let key = UploadTaskKey(appId: appId, taskId: taskId)
        let ownerToken = UUID()
        uploadTaskLock.lock()
        let previousTask = uploadTasks.updateValue(
            UploadTaskEntry(ownerToken: ownerToken, request: nil),
            forKey: key
        )?.request
        uploadTaskLock.unlock()
        previousTask?.cancel()
        return ownerToken
    }

    private static func storeUploadTask(
        _ task: UploadRequest,
        appId: String,
        taskId: String,
        ownerToken: UUID
    ) {
        let key = UploadTaskKey(appId: appId, taskId: taskId)
        uploadTaskLock.lock()
        if uploadTasks[key]?.ownerToken == ownerToken {
            uploadTasks[key]?.request = task
            uploadTaskLock.unlock()
        } else {
            uploadTaskLock.unlock()
            task.cancel()
        }
    }

    static func isUploadTaskActive(
        appId: String,
        taskId: String,
        ownerToken: UUID
    ) -> Bool {
        let key = UploadTaskKey(appId: appId, taskId: taskId)
        uploadTaskLock.lock()
        let isActive = uploadTasks[key]?.ownerToken == ownerToken
        uploadTaskLock.unlock()
        return isActive
    }

    private static func removeUploadTask(appId: String, taskId: String, ownerToken: UUID) {
        let key = UploadTaskKey(appId: appId, taskId: taskId)
        uploadTaskLock.lock()
        if uploadTasks[key]?.ownerToken == ownerToken {
            uploadTasks.removeValue(forKey: key)
        }
        uploadTaskLock.unlock()
    }

    private static func abortUploadTask(appId: String, taskId: String) {
        let key = UploadTaskKey(appId: appId, taskId: taskId)
        uploadTaskLock.lock()
        let task = uploadTasks.removeValue(forKey: key)?.request
        uploadTaskLock.unlock()
        task?.cancel()
    }

    /// Cancel and detach every upload event source owned by one mini-program
    /// runtime. Removing entries before cancel makes any racing progress or
    /// header callback fail its owner-token check.
    static func clearApp(_ appId: String) {
        uploadTaskLock.lock()
        let matchingKeys = uploadTasks.keys.filter { $0.appId == appId }
        let tasks = matchingKeys.compactMap { uploadTasks.removeValue(forKey: $0)?.request }
        uploadTaskLock.unlock()
        tasks.forEach { $0.cancel() }
    }
}
