//
//  ImageAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit
import Photos
import AVFoundation
import PhotosUI

// DMPError 用于表示API错误
public enum DMPError: Error {
    case invalidParam(message: String)
    case permissionDenied(message: String)
    case fileError(message: String)
    case viewControllerNotFound(message: String)
    case userCancelled
    case unknown(message: String)
}

/**
 * Media - Image API
 */
public class ImageAPI: DMPContainerApi {
    
    // API method names
    private static let SAVE_IMAGE_TO_PHOTOS_ALBUM = "saveImageToPhotosAlbum"
    private static let PREVIEW_IMAGE = "previewImage"
    private static let COMPRESS_IMAGE = "compressImage"
    private static let CHOOSE_IMAGE = "chooseImage"
    
    // Save image to photos album
    @BridgeMethod(SAVE_IMAGE_TO_PHOTOS_ALBUM)
    var saveImageToPhotosAlbum: DMPBridgeMethodHandler = { param, env, callback in
        guard let filePath = param.getMap()["filePath"] as? String else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "filePath is required")
            return DMPAsyncResult()
        }

        // 检查权限配置
        guard DMPPermissionManager.shared.isPermissionConfigured(.photoLibrary) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission not configured in Info.plist")
            return DMPAsyncResult()
        }

        // 检查权限
        DMPPermissionManager.shared.requestPermission(.photoLibrary) { status in
            guard status == .authorized else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Photo library permission denied")
                return
            }

            // 加载图片
            guard let image = UIImage(contentsOfFile: filePath) else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to load image")
                return
            }

            // 保存到相册
            UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
            DMPContainerApi.invokeSuccess(callback: callback, param: nil)
        }

        return DMPAsyncResult()
    }

    // Preview image
    @BridgeMethod(PREVIEW_IMAGE)
    var previewImage: DMPBridgeMethodHandler = { param, env, callback in
        guard let urls = param.getMap()["urls"] as? [String] else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "urls is required")
            return DMPAsyncResult()
        }

        if urls.isEmpty {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "urls cannot be empty")
            return DMPAsyncResult()
        }
        
        let current = param.getMap()["current"] as? String ?? urls.first!
        let showMenu = param.getMap()["showmenu"] as? Bool ?? true
        
        // 在这里实现图片预览功能，可以使用第三方库或自定义UIViewController
        DispatchQueue.main.async {
            let realUrls: [String] = urls.map { url in
                let realUrl = DMPFileUtil.sandboxPathFromVPath(from: url, appId: env.appId)
                return realUrl ?? url
            }
            let previewVC = DMPImagePreviewViewController(urls: realUrls, current: current, showMenu: showMenu)

            if let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() {
                topVC.present(previewVC, animated: true) {
                    DMPContainerApi.invokeSuccess(callback: callback, param: nil)
                }
            } else {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
            }
        }

        return DMPAsyncResult()
    }

    // Compress image
    @BridgeMethod(COMPRESS_IMAGE)
    var compressImage: DMPBridgeMethodHandler = { param, env, callback in
        guard let src = param.getMap()["src"] as? String else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "src is required")
            return DMPAsyncResult()
        }

        let sandboxPath = DMPFileUtil.sandboxPathFromVPath(from: src, appId: env.appId)
        
        guard let sandboxPath = sandboxPath else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to get sandbox path")
            return DMPAsyncResult()
        }

        // 读取图片
        guard let image = UIImage(contentsOfFile: sandboxPath) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to load image")
            return DMPAsyncResult()
        }
        
        // 压缩参数
        let quality = (param.getMap()["quality"] as? NSNumber)?.floatValue ?? 80
        let compressedWidth = param.getMap()["compressedWidth"] as? CGFloat
        let compressedHeight = param.getMap()["compressedHeight"] as? CGFloat
        
        // 根据参数调整图片大小
        var resizedImage = image
        if let width = compressedWidth, let height = compressedHeight {
            resizedImage = image.resize(to: CGSize(width: width, height: height))
        } else if let width = compressedWidth {
            let height = image.size.height * (width / image.size.width)
            resizedImage = image.resize(to: CGSize(width: width, height: height))
        } else if let height = compressedHeight {
            let width = image.size.width * (height / image.size.height)
            resizedImage = image.resize(to: CGSize(width: width, height: height))
        }
        
        // 压缩图片
        let compressionQuality = Float(quality) / 100.0
        guard let data = resizedImage.jpegData(compressionQuality: CGFloat(compressionQuality)) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to compress image")
            return DMPAsyncResult()
        }

        let fileModel: DMPImageFileModel? = DMPFileUtil.createTemporaryImagePath(data: data, appId: env.appId)
        guard let fileModel = fileModel else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to create temporary image path")
            return DMPAsyncResult()
        }

        DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(["tempFilePath": fileModel.vPath]))

        return DMPAsyncResult()
    }
    
    // Choose image
    @BridgeMethod(CHOOSE_IMAGE)
    var chooseImage: DMPBridgeMethodHandler = { param, env, callback in
        let count = (param.getMap()["count"] as? NSNumber)?.intValue ?? 9
        let sizeTypes = param.getMap()["sizeType"] as? [String] ?? ["original", "compressed"]
        let sourceTypes = param.getMap()["sourceType"] as? [String] ?? ["album", "camera"]
        
        // 如果sourceTypes包含多种选择，则显示ActionSheet让用户选择
        if sourceTypes.count > 1 {
            DispatchQueue.main.async {
                // 准备ActionSheet选项
                var options: [String] = []
                var optionTypes: [String] = []
                
                if sourceTypes.contains("camera") {
                    options.append("拍摄")
                    optionTypes.append("camera")
                }
                
                if sourceTypes.contains("album") {
                    options.append("从手机相册选择")
                    optionTypes.append("album")
                }
                
                // 显示ActionSheet
                ActionSheetManager.shared.showActionSheet(itemList: options) { selectedIndex in
                    if selectedIndex >= 0 && selectedIndex < optionTypes.count {
                        let selectedType = optionTypes[selectedIndex]
                        
                        // 检查并请求对应的权限
                        if selectedType == "album" {
                            ImageAPI.checkAndRequestAlbumPermission(count: count, sizeTypes: sizeTypes, env: env, callback: callback)
                        } else if selectedType == "camera" {
                            ImageAPI.checkAndRequestCameraPermission(count: count, sizeTypes: sizeTypes, env: env, callback: callback)
                        }
                    } else {
                        // 用户取消选择
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "User canceled")
                    }
                }
            }
        } else if sourceTypes.contains("album") {
            // 直接检查相册权限
            ImageAPI.checkAndRequestAlbumPermission(count: count, sizeTypes: sizeTypes, env: env, callback: callback)
        } else if sourceTypes.contains("camera") {
            // 直接检查相机权限
            ImageAPI.checkAndRequestCameraPermission(count: count, sizeTypes: sizeTypes, env: env, callback: callback)
        } else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Invalid sourceType")
        }
        
        return DMPAsyncResult()
    }

    // 检查并请求相册权限
    private static func checkAndRequestAlbumPermission(count: Int, sizeTypes: [String], env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
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
            DispatchQueue.main.async {
                ImageAPI.showImagePicker(count: count, sizeTypes: sizeTypes, sourceTypes: ["album"], env: env, callback: callback)
            }
        }
    }
    
    // 检查并请求相机权限
    private static func checkAndRequestCameraPermission(count: Int, sizeTypes: [String], env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        // 检查相机权限配置
        guard DMPPermissionManager.shared.isPermissionConfigured(.camera) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Camera permission not configured in Info.plist")
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
            
            // 继续处理
            DispatchQueue.main.async {
                ImageAPI.showImagePicker(count: count, sizeTypes: sizeTypes, sourceTypes: ["camera"], env: env, callback: callback)
            }
        }
    }
    
    private static func showImagePicker(count: Int, sizeTypes: [String], sourceTypes: [String], env: DMPBridgeEnv, callback: DMPBridgeCallback?) {
        // 创建图片选择器
        let picker: DMPImagePickerController = DMPImagePickerController()
        
        // 设置属性
        picker.maxSelectCount = count
        picker.allowedSizeTypes = sizeTypes
        picker.allowedSourceTypes = sourceTypes
        
        // 获取 topVC
        guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Cannot find view controller to present on")
            return
        }
        
        // 设置完成回调
        picker.completion = { (result: Result<[UIImage], DMPError>) in
            // 在主线程 dismiss
            DispatchQueue.main.async {
                topVC.dismiss(animated: true) {
                    switch result {
                    case .success(let images):
                        var tempFilePaths: [String] = []
                        var tempFiles: [[String: Any]] = []

                        let appId: String = env.appId
                        
                        for (_, image) in images.enumerated() {
                            let fileModel: DMPImageFileModel? = DMPFileUtil.createTemporaryImagePath(image: image, appId: appId)
                            if let fileModel = fileModel {
                                tempFilePaths.append(fileModel.vPath)
                                tempFiles.append([
                                    "path": fileModel.vPath,
                                    "size": fileModel.size
                                ])
                            }
                        }
                        
                        let resultMap = DMPMap()
                        resultMap["tempFilePaths"] = tempFilePaths
                        resultMap["tempFiles"] = tempFiles
                        
                        DMPContainerApi.invokeSuccess(callback: callback, param: resultMap)
                        
                    case .failure(let error):
                        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "Failed to choose image: \(error)")
                    }
                }
            }
        }
        
        // 显示图片选择器
        topVC.present(picker, animated: true, completion: nil)
    }
}

// MARK: - Helper Extensions & Classes

// UIImage 扩展，用于调整图片大小
extension UIImage {
    func resize(to size: CGSize) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { (context) in
            self.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

// UIViewController 扩展，用于获取顶层视图控制器
extension UIViewController {
    func topMostViewController() -> UIViewController {
        if let presented = self.presentedViewController {
            return presented.topMostViewController()
        }
        if let navigation = self as? UINavigationController {
            return navigation.visibleViewController?.topMostViewController() ?? navigation
        }
        if let tab = self as? UITabBarController {
            return tab.selectedViewController?.topMostViewController() ?? tab
        }
        return self
    }
}

// DMPImagePreviewViewController 用于预览图片
class DMPImagePreviewViewController: UIViewController, UIScrollViewDelegate {
    private let urls: [String]
    private let initialIndex: Int
    private let showMenu: Bool
    
    private var scrollView: UIScrollView!
    private var pageControl: UIPageControl!
    private var closeButton: UIButton!
    private var imageViews: [UIImageView] = []
    private var currentPage: Int = 0
    
    init(urls: [String], current: String, showMenu: Bool) {
        self.urls = urls
        self.initialIndex = urls.firstIndex(of: current) ?? 0
        self.showMenu = showMenu
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        loadImages()
    }
    
    private func setupUI() {
        view.backgroundColor = .black
        
        // 创建滚动视图
        scrollView = UIScrollView(frame: view.bounds)
        scrollView.delegate = self
        scrollView.isPagingEnabled = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentSize = CGSize(width: view.bounds.width * CGFloat(urls.count), height: view.bounds.height)
        view.addSubview(scrollView)
        
        // 创建页面指示器
        pageControl = UIPageControl(frame: CGRect(x: 0, y: view.bounds.height - 50, width: view.bounds.width, height: 30))
        pageControl.numberOfPages = urls.count
        pageControl.currentPage = initialIndex
        view.addSubview(pageControl)
        
        // 创建关闭按钮
        closeButton = UIButton(type: .custom)
        closeButton.frame = CGRect(x: 20, y: 40, width: 40, height: 40)
        closeButton.setTitle("×", for: .normal)
        closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 24, weight: .bold)
        closeButton.addTarget(self, action: #selector(closeButtonTapped), for: .touchUpInside)
        view.addSubview(closeButton)
        
        // 创建图片视图
        for i in 0..<urls.count {
            let imageView = UIImageView(frame: CGRect(x: view.bounds.width * CGFloat(i), y: 0, width: view.bounds.width, height: view.bounds.height))
            imageView.contentMode = .scaleAspectFit
            imageView.isUserInteractionEnabled = true
            scrollView.addSubview(imageView)
            imageViews.append(imageView)
            
            // 添加双击手势
            let doubleTapGesture = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
            doubleTapGesture.numberOfTapsRequired = 2
            imageView.addGestureRecognizer(doubleTapGesture)
        }
        
        // 设置初始页面
        scrollView.contentOffset = CGPoint(x: view.bounds.width * CGFloat(initialIndex), y: 0)
        currentPage = initialIndex
    }
    
    private func loadImages() {
        for (index, url) in urls.enumerated() {
            if let image = UIImage(contentsOfFile: url) {
                imageViews[index].image = image
            } else if url.hasPrefix("http") || url.hasPrefix("https") {
                // 加载网络图片
                DispatchQueue.global().async {
                    if let imageURL = URL(string: url), let data = try? Data(contentsOf: imageURL), let image = UIImage(data: data) {
                        DispatchQueue.main.async {
                            self.imageViews[index].image = image
                        }
                    }
                }
            }
        }
    }
    
    // MARK: - Actions
    
    @objc private func closeButtonTapped() {
        dismiss(animated: true, completion: nil)
    }
    
    @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
        if let imageView = gesture.view as? UIImageView {
            UIView.animate(withDuration: 0.3) {
                if imageView.contentMode == .scaleAspectFit {
                    imageView.contentMode = .scaleAspectFill
                } else {
                    imageView.contentMode = .scaleAspectFit
                }
            }
        }
    }
    
    // MARK: - UIScrollViewDelegate
    
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        let pageIndex = Int(scrollView.contentOffset.x / view.bounds.width)
        pageControl.currentPage = pageIndex
        currentPage = pageIndex
    }
}

// DMPImagePickerController 用于选择图片
class DMPImagePickerController: UIViewController, UINavigationControllerDelegate, UIImagePickerControllerDelegate, PHPickerViewControllerDelegate {
    var maxSelectCount: Int = 9
    var allowedSizeTypes: [String] = ["original", "compressed"]
    var allowedSourceTypes: [String] = ["album", "camera"]
    var completion: (Result<[UIImage], DMPError>) -> Void = { _ in }
    
    private var selectedImages: [UIImage] = []
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
            
            if self.allowedSourceTypes.contains("camera") {
                // 使用相机
                self.showCameraPicker()
            } else {
                // 使用相册
                self.showPhotoPicker()
            }
        }
    }
    
    // 显示相机
    private func showCameraPicker() {
        let picker = UIImagePickerController()
        picker.delegate = self
        picker.sourceType = .camera
        
        // 安全地呈现相机
        self.present(picker, animated: true, completion: nil)
    }
    
    // 显示相册选择器
    private func showPhotoPicker() {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = maxSelectCount // 0表示不限制数量
        configuration.filter = .images
        
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        self.present(picker, animated: true, completion: nil)
    }
    
    // MARK: - UIImagePickerControllerDelegate
    
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        if let image = info[.originalImage] as? UIImage {
            selectedImages.append(image)
            
            // 安全地关闭选择器
            picker.dismiss(animated: true) { [weak self] in
                guard let self = self else { return }
                // 主线程通知完成
                DispatchQueue.main.async {
                    self.completion(.success(self.selectedImages))
                }
            }
        } else {
            picker.dismiss(animated: true) { [weak self] in
                guard let self = self else { return }
                DispatchQueue.main.async {
                    self.completion(.failure(.unknown(message: "Failed to get image")))
                }
            }
        }
    }
    
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        // 安全地关闭选择器
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.completion(.failure(.userCancelled))
            }
        }
    }
    
    // MARK: - PHPickerViewControllerDelegate
    
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        // 先关闭选择器，然后处理结果
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            
            // 用户点击取消按钮
            if results.isEmpty {
                self.completion(.failure(.userCancelled))
                return
            }
            
            // 处理选中的图片
            let dispatchGroup = DispatchGroup()
            var images: [UIImage] = []
            
            for result in results {
                dispatchGroup.enter()
                
                if result.itemProvider.canLoadObject(ofClass: UIImage.self) {
                    result.itemProvider.loadObject(ofClass: UIImage.self) { (object, error) in
                        defer { dispatchGroup.leave() }
                        
                        if let image = object as? UIImage {
                            images.append(image)
                        }
                    }
                } else {
                    dispatchGroup.leave()
                }
            }
            
            dispatchGroup.notify(queue: .main) {
                if !images.isEmpty {
                    self.completion(.success(images))
                } else {
                    self.completion(.failure(.unknown(message: "Failed to load images")))
                }
            }
        }
    }
}
