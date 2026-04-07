//
//  VideoAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit
import Photos
import AVFoundation
import PhotosUI

/**
 * Media - Video API
 */
public class VideoAPI: DMPContainerApi {
    
    // API method names
    private static let CHOOSE_MEDIA = "chooseMedia"
    private static let CHOOSE_VIDEO = "chooseVideo"
    
    // Choose media
    @BridgeMethod(CHOOSE_MEDIA)
    var chooseMedia: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        
        let count = (param["count"] as? NSNumber)?.intValue ?? 9
        let mediaType = param["mediaType"] as? [String] ?? ["image", "video"]
        let sourceType = param["sourceType"] as? [String] ?? ["album", "camera"]
        let maxDuration = (param["maxDuration"] as? NSNumber)?.doubleValue ?? 10.0
        let sizeType = param["sizeType"] as? [String] ?? ["original", "compressed"]
        let camera = param["camera"] as? String ?? "back"
        
        // 检查参数有效性
        if count <= 0 || count > 20 {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "count must be between 1 and 20")
            return DMPAsyncResult()
        }

        if maxDuration < 3 || maxDuration > 60 {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "maxDuration must be between 3 and 60 seconds")
            return DMPAsyncResult()
        }
        
        // 如果sourceTypes包含多种选择，则显示ActionSheet让用户选择
        if sourceType.count > 1 {
            DispatchQueue.main.async {
                // 准备ActionSheet选项
                var options: [String] = []
                var optionTypes: [String] = []
                
                if sourceType.contains("camera") {
                    options.append("拍摄")
                    optionTypes.append("camera")
                }
                
                if sourceType.contains("album") {
                    options.append("从手机相册选择")
                    optionTypes.append("album")
                }
                
                // 显示ActionSheet
                ActionSheetManager.shared.showActionSheet(itemList: options) { selectedIndex in
                    if selectedIndex >= 0 && selectedIndex < optionTypes.count {
                        let selectedType = optionTypes[selectedIndex]
                        
                        // 检查并请求对应的权限
                        if selectedType == "album" {
                            VideoAPI.checkAndRequestAlbumPermission(count: count, mediaType: mediaType, sizeType: sizeType, maxDuration: maxDuration, env: env, callback: callback)
                        } else if selectedType == "camera" {
                            VideoAPI.checkAndRequestCameraPermission(count: count, mediaType: mediaType, sizeType: sizeType, camera: camera, maxDuration: maxDuration, env: env, callback: callback)
                        }
                    } else {
                        // 用户取消选择
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "User canceled")
                    }
                }
            }
        } else if sourceType.contains("album") {
            // 直接检查相册权限
            VideoAPI.checkAndRequestAlbumPermission(count: count, mediaType: mediaType, sizeType: sizeType, maxDuration: maxDuration, env: env, callback: callback)
        } else if sourceType.contains("camera") {
            // 直接检查相机权限
            VideoAPI.checkAndRequestCameraPermission(count: count, mediaType: mediaType, sizeType: sizeType, camera: camera, maxDuration: maxDuration, env: env, callback: callback)
        } else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Invalid sourceType")
        }

        return DMPAsyncResult()
    }

    // Choose video
    @BridgeMethod(CHOOSE_VIDEO)
    var chooseVideo: DMPBridgeMethodHandler = { param, env, callback in
        // 获取参数，与 chooseMedia 类似但只针对视频
        let sourceType = param.getMap()["sourceType"] as? [String] ?? ["album", "camera"]
        let compressed = param.getMap()["compressed"] as? Bool ?? true
        let maxDuration = (param.getMap()["maxDuration"] as? NSNumber)?.doubleValue ?? 60.0
        let camera = param.getMap()["camera"] as? String ?? "back"
        
        // 如果sourceTypes包含多种选择，则显示ActionSheet让用户选择
        if sourceType.count > 1 {
            DispatchQueue.main.async {
                // 准备ActionSheet选项
                var options: [String] = []
                var optionTypes: [String] = []
                
                if sourceType.contains("camera") {
                    options.append("拍摄视频")
                    optionTypes.append("camera")
                }
                
                if sourceType.contains("album") {
                    options.append("从手机相册选择视频")
                    optionTypes.append("album")
                }
                
                // 显示ActionSheet
                ActionSheetManager.shared.showActionSheet(itemList: options) { selectedIndex in
                    if selectedIndex >= 0 && selectedIndex < optionTypes.count {
                        let selectedType = optionTypes[selectedIndex]
                        
                        // 检查并请求对应的权限
                        if selectedType == "album" {
                            VideoAPI.checkAndRequestVideoPermission(sourceType: "album", compressed: compressed, maxDuration: maxDuration, camera: camera, env: env, callback: callback)
                        } else if selectedType == "camera" {
                            VideoAPI.checkAndRequestVideoPermission(sourceType: "camera", compressed: compressed, maxDuration: maxDuration, camera: camera, env: env, callback: callback)
                        }
                    } else {
                        // 用户取消选择
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "User canceled")
                    }
                }
            }
        } else if sourceType.contains("album") {
            // 直接检查相册权限
            VideoAPI.checkAndRequestVideoPermission(sourceType: "album", compressed: compressed, maxDuration: maxDuration, camera: camera, env: env, callback: callback)
        } else if sourceType.contains("camera") {
            // 直接检查相机权限
            VideoAPI.checkAndRequestVideoPermission(sourceType: "camera", compressed: compressed, maxDuration: maxDuration, camera: camera, env: env, callback: callback)
        } else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Invalid sourceType")
        }

        return DMPAsyncResult()
    }

    // MARK: - Helper methods for chooseMedia
    
    // 检查并请求相册权限 (用于 chooseMedia)
    private static func checkAndRequestAlbumPermission(count: Int, mediaType: [String], sizeType: [String], maxDuration: Double, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        // 检查权限配置
        guard DMPPermissionManager.shared.isPermissionConfigured(.photoLibrary) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission not configured in Info.plist")
            return
        }
        
        DMPPermissionManager.shared.requestPermission(.photoLibrary) { status in
            if status != .authorized && status != .limited {
                DispatchQueue.main.async {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission denied")
                }
                return
            }
            
            // 继续处理
            let picker = DMPMediaPickerController()
            picker.maxSelectCount = count
            picker.allowedMediaTypes = mediaType
            picker.sizeTypes = sizeType
            picker.maxDuration = maxDuration
            picker.sourceType = .photoLibrary

            guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
                return
            }

            picker.completion = { result in
                // 使用 DispatchWorkItem 明确处理异步任务
                let workItem = DispatchWorkItem {
                    switch result {
                    case .success(let mediaFiles):
                        topVC.dismiss(animated: true) {
                            VideoAPI.processMediaFiles(mediaFiles: mediaFiles, env: env, callback: callback)
                        }
                        
                    case .failure(let error):
                        topVC.dismiss(animated: true) {
                            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to choose video: \(error)")
                        }
                    }
                }
                
                DispatchQueue.main.async(execute: workItem)
            }
            
            // 显示媒体选择器
            topVC.present(picker, animated: true, completion: nil)
        }
    }
    
    // 检查并请求相机权限 (用于 chooseMedia)
    private static func checkAndRequestCameraPermission(count: Int, mediaType: [String], sizeType: [String], camera: String, maxDuration: Double, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        // 检查相机权限配置
        guard DMPPermissionManager.shared.isPermissionConfigured(.camera) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Camera permission not configured in Info.plist")
            return
        }
        
        // 如果包含视频类型，还需要检查麦克风权限
        if mediaType.contains("video") || mediaType.contains("mix") {
            guard DMPPermissionManager.shared.isPermissionConfigured(.microphone) else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Microphone permission not configured in Info.plist")
                return
            }
        }
        
        // 检查相机权限
        DMPPermissionManager.shared.requestPermission(.camera) { status in
            if status != .authorized {
                DispatchQueue.main.async {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Camera permission denied")
                }
                return
            }
            
            // 如果包含视频类型，还需要检查麦克风权限
            if mediaType.contains("video") || mediaType.contains("mix") {
                DMPPermissionManager.shared.requestPermission(.microphone) { micStatus in
                    if micStatus != .authorized {
                        DispatchQueue.main.async {
                            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Microphone permission denied")
                        }
                        return
                    }
                    
                    DispatchQueue.main.async {
                        VideoAPI.showCameraMediaPicker(count: count, mediaType: mediaType, sizeType: sizeType, camera: camera, maxDuration: maxDuration, env: env, callback: callback)
                    }
                }
            } else {
                DispatchQueue.main.async {
                    VideoAPI.showCameraMediaPicker(count: count, mediaType: mediaType, sizeType: sizeType, camera: camera, maxDuration: maxDuration, env: env, callback: callback)
                }
            }
        }
    }
    
    // 显示相机媒体选择器 (用于 chooseMedia)
    private static func showCameraMediaPicker(count: Int, mediaType: [String], sizeType: [String], camera: String, maxDuration: Double, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        let picker = DMPMediaPickerController()
        picker.maxSelectCount = count
        picker.allowedMediaTypes = mediaType
        picker.sizeTypes = sizeType
        picker.maxDuration = maxDuration
        picker.sourceType = .camera
        picker.cameraDevice = camera == "front" ? .front : .rear

        guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
            return
        }

        picker.completion = { result in
            switch result {
            case .success(let mediaFiles):
                topVC.dismiss(animated: true) {
                    VideoAPI.processMediaFiles(mediaFiles: mediaFiles, env: env, callback: callback)
                }
            case .failure(let error):
                topVC.dismiss(animated: true) {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to choose media: \(error)")
                }
            }
        }
        
        topVC.present(picker, animated: true, completion: nil)
    }
    
    // 处理媒体文件 (用于 chooseMedia)
    private static func processMediaFiles(mediaFiles: [DMPMediaFile], env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        var tempFiles: [[String: Any]] = []
        let appId = env.appId
        
        for mediaFile in mediaFiles {
            var fileInfo: [String: Any] = [:]
            
            switch mediaFile {
            case .image(let image):
                // 处理图片
                guard let fileModel = DMPFileUtil.createTemporaryImagePath(image: image, appId: appId) else {
                    continue
                }
                
                fileInfo["tempFilePath"] = fileModel.vPath
                fileInfo["size"] = fileModel.size
                fileInfo["fileType"] = "image"
                fileInfo["type"] = "image"
                
            case .video(let url):
                // 处理视频
                guard let videoModel = DMPFileUtil.createTemporaryVideoPath(url: url, appId: appId, compress: true) else {
                    continue
                }
                
                fileInfo["tempFilePath"] = videoModel.vPath
                fileInfo["size"] = videoModel.size
                fileInfo["duration"] = videoModel.duration / 1000 // 转换为秒
                fileInfo["height"] = videoModel.height
                fileInfo["width"] = videoModel.width
                fileInfo["fileType"] = "video"
                fileInfo["type"] = "video"
                
                // 创建视频缩略图
                if let thumbPath = DMPFileUtil.createVideoThumbnailFile(from: url, appId: appId) {
                    fileInfo["thumbTempFilePath"] = thumbPath
                }
            }
            
            if !fileInfo.isEmpty {
                tempFiles.append(fileInfo)
            }
        }
        
        // 返回结果
        let resultMap = DMPMap()
        resultMap["tempFiles"] = tempFiles
        let mediaType = mediaFiles.isEmpty ? "mix" : mediaFiles.first?.mediaType ?? "mix"
        resultMap["type"] = mediaType
        
        DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
    }
    
    // MARK: - Helper methods for chooseVideo
    
    // 检查并请求视频权限 (用于 chooseVideo)
    private static func checkAndRequestVideoPermission(sourceType: String, compressed: Bool, maxDuration: Double, camera: String, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        if sourceType == "album" {
            // 检查相册权限
            guard DMPPermissionManager.shared.isPermissionConfigured(.photoLibrary) else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission not configured in Info.plist")
                return
            }
            
            DMPPermissionManager.shared.requestPermission(.photoLibrary) { status in
                if status != .authorized && status != .limited {
                    DispatchQueue.main.async {
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission denied")
                    }
                    return
                }
                
                DispatchQueue.main.async {
                    VideoAPI.showVideoAlbumPicker(compressed: compressed, maxDuration: maxDuration, env: env, callback: callback)
                }
            }
        } else if sourceType == "camera" {
            // 检查相机权限
            guard DMPPermissionManager.shared.isPermissionConfigured(.camera) else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Camera permission not configured in Info.plist")
                return
            }
            
            // 检查麦克风权限
            guard DMPPermissionManager.shared.isPermissionConfigured(.microphone) else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Microphone permission not configured in Info.plist")
                return
            }
            
            // 检查相机权限
            DMPPermissionManager.shared.requestPermission(.camera) { status in
                if status != .authorized {
                    DispatchQueue.main.async {
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Camera permission denied")
                    }
                    return
                }
                
                // 检查麦克风权限
                DMPPermissionManager.shared.requestPermission(.microphone) { micStatus in
                    if micStatus != .authorized {
                        DispatchQueue.main.async {
                            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Microphone permission denied")
                        }
                        return
                    }
                    
                    DispatchQueue.main.async {
                        VideoAPI.showVideoCameraPicker(compressed: compressed, maxDuration: maxDuration, camera: camera, env: env, callback: callback)
                    }
                }
            }
        } else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Invalid sourceType")
        }
    }
    
    // 显示相册视频选择器 (用于 chooseVideo)
    private static func showVideoAlbumPicker(compressed: Bool, maxDuration: Double, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        let picker = DMPVideoPickerController()
        picker.maxDuration = maxDuration
        picker.compressed = compressed
        picker.sourceType = .photoLibrary

        guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
            return
        }
        
        picker.completion = { result in
            switch result {
            case .success(let url):
                topVC.dismiss(animated: true) {
                    VideoAPI.processVideoFile(url: url, compressed: compressed, env: env, callback: callback)
                }
            case .failure(let error):
                topVC.dismiss(animated: true) {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to choose video: \(error)")
                }
            }
        }
        
        topVC.present(picker, animated: true, completion: nil)
    }
    
    // 显示相机视频拍摄 (用于 chooseVideo)
    private static func showVideoCameraPicker(compressed: Bool, maxDuration: Double, camera: String, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        let picker = DMPVideoPickerController()
        picker.maxDuration = maxDuration
        picker.compressed = compressed
        picker.sourceType = .camera
        picker.cameraDevice = camera == "front" ? .front : .rear

        guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
            return
        }
        
        picker.completion = { result in
            switch result {
            case .success(let url):
                topVC.dismiss(animated: true) {
                    VideoAPI.processVideoFile(url: url, compressed: compressed, env: env, callback: callback)
                }
            case .failure(let error):
                topVC.dismiss(animated: true) {
                    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to choose video: \(error)")
                }
            }
        }
        
        topVC.present(picker, animated: true, completion: nil)
    }
    
    // 处理视频文件 (用于 chooseVideo)
    private static func processVideoFile(url: URL, compressed: Bool, env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        // 保存视频到临时文件夹
        guard let videoModel = DMPFileUtil.createTemporaryVideoPath(url: url, appId: env.appId, compress: compressed) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to process video")
            return
        }
        
        // 创建视频缩略图
        let thumbTempFilePath = DMPFileUtil.createVideoThumbnailFile(from: url, appId: env.appId)
        
        // 返回结果
        let resultMap = DMPMap()
        resultMap["tempFilePath"] = videoModel.vPath
        resultMap["size"] = videoModel.size
        resultMap["duration"] = videoModel.duration / 1000 // 转换为秒
        resultMap["height"] = videoModel.height
        resultMap["width"] = videoModel.width
        
        if let thumbPath = thumbTempFilePath {
            resultMap["thumbTempFilePath"] = thumbPath
        }
        
        DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
    }
}

// MARK: - Media Models

// 媒体类型枚举
public enum DMPMediaFile {
    case image(UIImage)
    case video(URL)
    
    var mediaType: String {
        switch self {
        case .image:
            return "image"
        case .video:
            return "video"
        }
    }
}

// MARK: - Media Pickers

// DMPMediaPickerController 用于选择图片和视频
class DMPMediaPickerController: UIViewController, UINavigationControllerDelegate, UIImagePickerControllerDelegate, PHPickerViewControllerDelegate {
    var maxSelectCount: Int = 9
    var allowedMediaTypes: [String] = ["image", "video"]
    var sizeTypes: [String] = ["original", "compressed"]
    var maxDuration: Double = 10.0
    var sourceType: UIImagePickerController.SourceType = .photoLibrary
    var cameraDevice: UIImagePickerController.CameraDevice = .rear
    
    var completion: (Result<[DMPMediaFile], DMPError>) -> Void = { _ in }
    
    private var selectedMedia: [DMPMediaFile] = []
    private var isPresenting: Bool = false
    
    override func viewDidLoad() {
        super.viewDidLoad()
        // 仅设置背景色
        view.backgroundColor = UIColor.black.withAlphaComponent(0.5)
    }
    
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        
        // 防止重复显示
        if isPresenting {
            return
        }
        
        // 标记为正在呈现，避免重复操作
        isPresenting = true
        
        // 添加一个短暂延迟，确保当前控制器完全呈现
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }
            
            if self.sourceType == .camera {
                // 使用相机
                self.showCameraPicker()
            } else {
                // 使用相册
                if #available(iOS 14.0, *) {
                    self.showPHPicker()
                } else {
                    self.showImagePicker()
                }
            }
        }
    }
    
    // 显示相机
    private func showCameraPicker() {
        let picker = UIImagePickerController()
        picker.delegate = self
        picker.sourceType = .camera
        picker.cameraDevice = cameraDevice
        
        // 设置媒体类型
        var mediaTypes: [String] = []
        if allowedMediaTypes.contains("image") {
            mediaTypes.append("public.image")
        }
        if allowedMediaTypes.contains("video") || allowedMediaTypes.contains("mix") {
            mediaTypes.append("public.movie")
        }
        picker.mediaTypes = mediaTypes
        
        // 设置视频最长时间
        picker.videoMaximumDuration = maxDuration
        
        self.present(picker, animated: true, completion: nil)
    }
    
    // 显示传统图片选择器
    private func showImagePicker() {
        let picker = UIImagePickerController()
        picker.delegate = self
        picker.sourceType = .photoLibrary
        
        // 设置媒体类型
        var mediaTypes: [String] = []
        if allowedMediaTypes.contains("image") {
            mediaTypes.append("public.image")
        }
        if allowedMediaTypes.contains("video") || allowedMediaTypes.contains("mix") {
            mediaTypes.append("public.movie")
        }
        picker.mediaTypes = mediaTypes
        
        // 设置视频最长时间
        picker.videoMaximumDuration = maxDuration
        
        self.present(picker, animated: true, completion: nil)
    }
    
    // 显示 PHPicker (iOS 14+)
    @available(iOS 14.0, *)
    private func showPHPicker() {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = maxSelectCount
        
        // 设置媒体类型
        var filter: PHPickerFilter?
        if allowedMediaTypes.contains("image") && (allowedMediaTypes.contains("video") || allowedMediaTypes.contains("mix")) {
            filter = PHPickerFilter.any(of: [.images, .videos])
        } else if allowedMediaTypes.contains("image") {
            filter = .images
        } else if allowedMediaTypes.contains("video") || allowedMediaTypes.contains("mix") {
            filter = .videos
        }
        
        configuration.filter = filter
        
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        self.present(picker, animated: true, completion: nil)
    }
    
    // MARK: - UIImagePickerControllerDelegate
    
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        if let mediaType = info[.mediaType] as? String {
            if mediaType == "public.image", let image = info[.originalImage] as? UIImage {
                // 处理图片
                selectedMedia.append(.image(image))
            } else if mediaType == "public.movie", let videoURL = info[.mediaURL] as? URL {
                // 处理视频
                selectedMedia.append(.video(videoURL))
            }
        }
        
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.completion(.success(self.selectedMedia))
            }
        }
    }
    
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.completion(.failure(.userCancelled))
            }
        }
    }
    
    // MARK: - PHPickerViewControllerDelegate
    
    @available(iOS 14.0, *)
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            
            if results.isEmpty {
                self.completion(.failure(.userCancelled))
                return
            }
            
            // 创建组等待处理完成
            let dispatchGroup = DispatchGroup()
            
            for result in results {
                // 处理图片
                if result.itemProvider.canLoadObject(ofClass: UIImage.self) {
                    dispatchGroup.enter()
                    
                    result.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] (object, error) in
                        defer { dispatchGroup.leave() }
                        
                        if let image = object as? UIImage {
                            DispatchQueue.main.async {
                                self?.selectedMedia.append(.image(image))
                            }
                        }
                    }
                }
                // 处理视频
                else if result.itemProvider.hasItemConformingToTypeIdentifier("public.movie") {
                    dispatchGroup.enter()
                    
                    result.itemProvider.loadFileRepresentation(forTypeIdentifier: "public.movie") { [weak self] (url, error) in
                        defer { dispatchGroup.leave() }
                        
                        if let url = url {
                            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
                            
                            do {
                                if FileManager.default.fileExists(atPath: tempURL.path) {
                                    try FileManager.default.removeItem(at: tempURL)
                                }
                                try FileManager.default.copyItem(at: url, to: tempURL)
                                
                                DispatchQueue.main.async {
                                    self?.selectedMedia.append(.video(tempURL))
                                }
                            } catch {
                                print("Failed to copy video: \(error)")
                            }
                        }
                    }
                }
            }
            
            // 等待所有媒体处理完成
            dispatchGroup.notify(queue: .main) { [weak self] in
                guard let self = self else { return }
                
                if !self.selectedMedia.isEmpty {
                    self.completion(.success(self.selectedMedia))
                } else {
                    self.completion(.failure(.unknown(message: "Failed to load media files")))
                }
            }
        }
    }
}

// DMPVideoPickerController 用于专门选择视频
class DMPVideoPickerController: UIViewController, UINavigationControllerDelegate, UIImagePickerControllerDelegate, PHPickerViewControllerDelegate {
    var maxDuration: Double = 60.0
    var compressed: Bool = true
    var sourceType: UIImagePickerController.SourceType = .photoLibrary
    var cameraDevice: UIImagePickerController.CameraDevice = .rear
    
    var completion: (Result<URL, DMPError>) -> Void = { _ in }
    private var isPresenting: Bool = false
    
    override func viewDidLoad() {
        super.viewDidLoad()
        // 仅设置背景色
        view.backgroundColor = UIColor.black.withAlphaComponent(0.5)
    }
    
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        
        // 防止重复显示
        if isPresenting {
            return
        }
        
        // 标记为正在呈现，避免重复操作
        isPresenting = true
        
        // 添加一个短暂延迟，确保当前控制器完全呈现
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }
            
            if self.sourceType == .camera {
                // 使用相机
                self.showCameraPicker()
            } else {
                // 使用相册
                if #available(iOS 14.0, *) {
                    self.showPHPicker()
                } else {
                    self.showImagePicker()
                }
            }
        }
    }
    
    // 显示相机
    private func showCameraPicker() {
        let picker = UIImagePickerController()
        picker.delegate = self
        picker.sourceType = .camera
        picker.cameraDevice = cameraDevice
        picker.mediaTypes = ["public.movie"]
        picker.videoMaximumDuration = maxDuration
        picker.videoQuality = compressed ? .typeMedium : .typeHigh
        
        self.present(picker, animated: true, completion: nil)
    }
    
    // 显示传统图片选择器
    private func showImagePicker() {
        let picker = UIImagePickerController()
        picker.delegate = self
        picker.sourceType = .photoLibrary
        picker.mediaTypes = ["public.movie"]
        picker.videoMaximumDuration = maxDuration
        
        self.present(picker, animated: true, completion: nil)
    }
    
    // 显示 PHPicker (iOS 14+)
    @available(iOS 14.0, *)
    private func showPHPicker() {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = 1
        configuration.filter = .videos
        
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        self.present(picker, animated: true, completion: nil)
    }
    
    // MARK: - UIImagePickerControllerDelegate
    
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        if let videoURL = info[.mediaURL] as? URL {
            picker.dismiss(animated: true) { [weak self] in
                guard let self = self else { return }
                DispatchQueue.main.async {
                    self.completion(.success(videoURL))
                }
            }
        } else {
            picker.dismiss(animated: true) { [weak self] in
                guard let self = self else { return }
                DispatchQueue.main.async {
                    self.completion(.failure(.fileError(message: "Failed to get video URL")))
                }
            }
        }
    }
    
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.completion(.failure(.userCancelled))
            }
        }
    }
    
    // MARK: - PHPickerViewControllerDelegate
    
    @available(iOS 14.0, *)
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            
            if results.isEmpty {
                self.completion(.failure(.userCancelled))
                return
            }
            
            guard let result = results.first else {
                self.completion(.failure(.unknown(message: "No video selected")))
                return
            }
            
            if result.itemProvider.hasItemConformingToTypeIdentifier("public.movie") {
                result.itemProvider.loadFileRepresentation(forTypeIdentifier: "public.movie") { [weak self] (url, error) in
                    guard let self = self else { return }
                    
                    if let error = error {
                        DispatchQueue.main.async {
                            self.completion(.failure(.fileError(message: "Failed to load video: \(error.localizedDescription)")))
                        }
                        return
                    }
                    
                    guard let url = url else {
                        DispatchQueue.main.async {
                            self.completion(.failure(.fileError(message: "Failed to get video URL")))
                        }
                        return
                    }
                    
                    let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
                    
                    do {
                        if FileManager.default.fileExists(atPath: tempURL.path) {
                            try FileManager.default.removeItem(at: tempURL)
                        }
                        try FileManager.default.copyItem(at: url, to: tempURL)
                        
                        DispatchQueue.main.async {
                            self.completion(.success(tempURL))
                        }
                    } catch {
                        DispatchQueue.main.async {
                            self.completion(.failure(.fileError(message: "Failed to copy video: \(error.localizedDescription)")))
                        }
                    }
                }
            } else {
                self.completion(.failure(.fileError(message: "Selected item is not a video")))
            }
        }
    }
}
