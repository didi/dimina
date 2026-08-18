//
//  DMPNetwork.swift
//  dimina
//
//  Created by Lehem on 2025/5/14.
//

import Foundation
import Alamofire

/**
 * DMPNetwork
 * A network utility class that encapsulates Alamofire networking operations
 * Provides methods for HTTP requests, file downloads, and file uploads
 * Supports various data types and content types
 */
class DMPNetwork {
    
    // Singleton instance for shared network operations
    static let shared = DMPNetwork()
    
    // Private initializer to prevent direct instantiation
    private init() {}
    
    /**
     * Performs an HTTP request with flexible configuration
     *
     * @param url The target URL for the request
     * @param method HTTP method (GET, POST, PUT, DELETE, etc.)
     * @param data Request payload data
     * @param header Custom HTTP headers
     * @param timeout Request timeout interval
     * @param dataType Expected response data type (e.g., JSON)
     * @param success Callback for successful request
     * @param fail Callback for request failure
     * @param complete Callback for request completion
     */
    func request(
        url: String,
        method: HTTPMethod,
        data: Any?,
        header: [String: String]?,
        timeout: TimeInterval,
        dataType: String,
        success: @escaping (Data?, Int, [String: String], [String]) -> Void,
        fail: @escaping (String, Int?) -> Void,
        complete: @escaping () -> Void
    ) {
        // 默认为application/json
        var headers: HTTPHeaders = header.map { HTTPHeaders($0) } ?? []
        if headers["content-type"] == nil {
            headers["content-type"] = "application/json"
        }
        
        // 创建请求配置
        var request = URLRequest(url: URL(string: url)!)
        request.method = method
        request.headers = headers
        request.timeoutInterval = timeout
        
        // 处理请求数据
        if let requestData = data {
            // 根据content-type处理请求数据
            let contentType = headers["content-type"]?.lowercased() ?? "application/json"
            
            if contentType.contains("application/json") {
                // JSON数据
                if let parameters = requestData as? [String: Any] {
                    do {
                        let jsonData = try JSONSerialization.data(withJSONObject: parameters)
                        request.httpBody = jsonData
                    } catch {
                        fail("request:fail invalid JSON data", nil)
                        return
                    }
                } else if let jsonString = requestData as? String {
                    request.httpBody = jsonString.data(using: .utf8)
                } else if let jsonData = requestData as? Data {
                    request.httpBody = jsonData
                }
            } else if contentType.contains("application/x-www-form-urlencoded") {
                // 表单数据
                if let parameters = requestData as? [String: Any] {
                    let formData = parameters.map { key, value in
                        let valueString = "\(value)"
                        return "\(key)=\(valueString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
                    }.joined(separator: "&")
                    request.httpBody = formData.data(using: .utf8)
                }
            } else {
                // 其他类型，尝试直接设置
                if let stringData = requestData as? String {
                    request.httpBody = stringData.data(using: .utf8)
                } else if let binaryData = requestData as? Data {
                    request.httpBody = binaryData
                }
            }
        }
        
        // 使用Alamofire发送请求
        AF.request(request)
            .validate()
            .responseData { response in
                // 记录网络请求过程信息（可以扩展更多指标）
                let profile = ["timestamp": Date().timeIntervalSince1970]
                
                switch response.result {
                case .success(let data):
                    // 提取响应头
                    let responseHeaders = response.response?.allHeaderFields as? [String: String] ?? [:]
                    
                    // 提取Cookie（以字符串数组形式返回）
                    var cookies: [String] = []
                    if let cookieHeader = responseHeaders["Set-Cookie"] {
                        cookies = cookieHeader.components(separatedBy: "; ")
                    }
                    
                    // 正确获得状态码
                    let statusCode = response.response?.statusCode ?? 200
                    success(data, statusCode, responseHeaders, cookies)
                    
                case .failure(let error):
                    // 错误处理，从AF.Error中获取错误码
                    let statusCode = error.responseCode
                    
                    // 构建错误信息
                    let errorMessage = "request:fail \(error.localizedDescription)"
                    fail(errorMessage, statusCode)
                }
                
                // 完成回调
                complete()
            }
    }
    
    /**
     * Downloads a file from a specified URL
     *
     * @param url The URL of the file to download
     * @param header Custom HTTP headers
     * @param timeout Download timeout interval
     * @param filePath Optional custom file path for saving the downloaded file
     * @param success Callback with downloaded file path and status code
     * @param fail Callback for download failure
     * @param complete Callback for download completion
     */
    func downloadFile(
        url: String,
        header: [String: String]?,
        timeout: TimeInterval,
        filePath: String?,
        success: @escaping (String, Int) -> Void,
        fail: @escaping (String) -> Void,
        complete: @escaping () -> Void
    ) {
        // 设置下载路径（用户指定或临时目录）
        let destination: DownloadRequest.Destination
        let finalFilePath: String
        
        if let customPath = filePath {
            finalFilePath = customPath
            destination = { _, _ in
                let fileURL = URL(fileURLWithPath: customPath)
                return (fileURL, [.createIntermediateDirectories, .removePreviousFile])
            }
        } else {
            // 使用临时目录生成临时文件路径
            let tempDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
            let fileName = UUID().uuidString
            let fileURL = tempDirectoryURL.appendingPathComponent(fileName)
            finalFilePath = fileURL.path
            
            destination = { _, _ in
                return (fileURL, [.createIntermediateDirectories])
            }
        }
        
        // 创建请求头
        let headers: HTTPHeaders? = header.map { HTTPHeaders($0) }
        
        // 开始下载
        AF.download(url, method: .get, headers: headers, requestModifier: { request in
            request.timeoutInterval = timeout
        }, to: destination)
        .validate()
        .responseURL { response in
            switch response.result {
            case .success(_):
                // 成功下载文件
                let statusCode = response.response?.statusCode ?? 200
                success(finalFilePath, statusCode)
                
            case .failure(let error):
                // 下载失败
                let errorMessage = "downloadFile:fail \(error.localizedDescription)"
                fail(errorMessage)
            }
            
            // 完成回调
            complete()
        }
    }
    
    /**
     * Uploads a file to a specified URL
     *
     * @param url The target upload URL
     * @param filePath Path to the file to be uploaded
     * @param name The name of the file in the form data
     * @param header Custom HTTP headers
     * @param formData Additional form data to be sent with the file
     * @param timeout Upload timeout interval
     * @param success Callback with server response and status code
     * @param fail Callback for upload failure
     * @param progress Callback for upload progress
     * @param headersReceived Callback for response headers
     */
    @discardableResult
    func uploadFile(
        url: String,
        filePath: String,
        name: String,
        header: [String: String]?,
        formData: [String: Any]?,
        timeout: TimeInterval,
        progress: @escaping (Int64, Int64) -> Void,
        headersReceived: @escaping ([String: String]) -> Void,
        success: @escaping (String, Int) -> Void,
        fail: @escaping (String) -> Void
    ) -> UploadRequest {
        // 创建文件URL
        let fileURL = URL(fileURLWithPath: filePath)
        
        // 创建请求头，默认是multipart/form-data
        let headers: HTTPHeaders = header.map { HTTPHeaders($0) } ?? []
        
        // 开始上传
        let request = AF.upload(multipartFormData: { multipartFormData in
            // 添加文件
            multipartFormData.append(fileURL, withName: name)
            
            // 添加额外的表单数据
            if let formData = formData {
                for (key, value) in formData {
                    if let stringValue = value as? String {
                        if let data = stringValue.data(using: .utf8) {
                            multipartFormData.append(data, withName: key)
                        }
                    } else if let intValue = value as? Int {
                        if let data = "\(intValue)".data(using: .utf8) {
                            multipartFormData.append(data, withName: key)
                        }
                    } else if let boolValue = value as? Bool {
                        if let data = "\(boolValue)".data(using: .utf8) {
                            multipartFormData.append(data, withName: key)
                        }
                    }
                }
            }
        }, to: url, method: .post, headers: headers, requestModifier: { request in
            request.timeoutInterval = timeout
        })
        .uploadProgress { uploadProgress in
            progress(uploadProgress.completedUnitCount, uploadProgress.totalUnitCount)
        }
        .onHTTPResponse { response in
            var responseHeaders: [String: String] = [:]
            response.allHeaderFields.forEach { key, value in
                responseHeaders[String(describing: key)] = String(describing: value)
            }
            headersReceived(responseHeaders)
        }
        .responseData { response in
            switch response.result {
            case .success(let data):
                // 成功上传文件并获得响应
                let statusCode = response.response?.statusCode ?? 200
                
                // 将服务器返回数据转换为字符串
                let responseString = String(data: data, encoding: .utf8) ?? ""
                success(responseString, statusCode)
                
            case .failure(let error):
                // 上传失败
                let errorMessage = error.isExplicitlyCancelledError
                    ? "uploadFile:fail abort"
                    : "uploadFile:fail \(error.localizedDescription)"
                fail(errorMessage)
            }
        }

        return request
    }
}
