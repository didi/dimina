//
//  DMPFileUtil.swift
//  dimina
//
//  Created by Lehem on 2025/5/16.
//

import Foundation
import UIKit
import AVFoundation

extension DMPFileUtil {
    
    public static func createTemporaryImagePath(image: UIImage, appId: String) -> DMPImageFileModel? {
        guard let data = image.jpegData(compressionQuality: 1.0) else {
            DMPLogger.debug("Failed to create JPEG data from image")
            return nil
        }

        return DMPFileUtil.createTemporaryImagePath(data: data, appId: appId)
    }

    public static func createTemporaryImagePath(data: Data, appId: String) -> DMPImageFileModel? {
        let tmpPath = DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId)
        
        do {
            try FileManager.default.createDirectory(
                atPath: tmpPath,
                withIntermediateDirectories: true,
                attributes: nil)
        } catch {
            DMPLogger.debug("Failed to create temporary directory: \(error.localizedDescription)")
            return nil
        }
        
        // 生成基于时间戳的 MD5 文件名
        let timeStr: String = String(format: "%.0f", Date().timeIntervalSince1970 * 1000)
        let fileName: String = "tmp_\(timeStr.dmp_sha256).jpg"
        let imagePath: String = (tmpPath as NSString).appendingPathComponent(fileName)
        let vPath: String = DMPFileUtil.vPathFromSandboxPath(sandboxPath: imagePath, appId: appId)

        do {
            try data.write(to: URL(fileURLWithPath: imagePath))
            return DMPImageFileModel(path: imagePath, size: data.count, vPath: vPath)
        } catch {
            DMPLogger.debug("Failed to write image data: \(error.localizedDescription)")
            return nil
        }
    }
    
    // 创建临时视频路径
    public static func createTemporaryVideoPath(url: URL, appId: String, compress: Bool = true) -> DMPVideoFileModel? {
        let asset = AVAsset(url: url)
        let duration = Int(CMTimeGetSeconds(asset.duration) * 1000) // 转为毫秒
        
        // 获取视频尺寸
        var width = 0
        var height = 0
        if let track = asset.tracks(withMediaType: .video).first {
            let size = track.naturalSize.applying(track.preferredTransform)
            width = Int(abs(size.width))
            height = Int(abs(size.height))
        }
        
        // 获取文件大小
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let fileSize = attrs[.size] as? Int else {
            DMPLogger.debug("Failed to get video file size")
            return nil
        }
        
        // 创建临时目录
        let tmpPath = DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId)
        do {
            try FileManager.default.createDirectory(
                atPath: tmpPath,
                withIntermediateDirectories: true,
                attributes: nil)
        } catch {
            DMPLogger.debug("Failed to create temporary directory: \(error.localizedDescription)")
            return nil
        }
        
        // 生成临时文件路径
        let timeStr: String = String(format: "%.0f", Date().timeIntervalSince1970 * 1000)
        let fileName: String = "tmp_\(timeStr.dmp_sha256).mp4"
        let videoPath: String = (tmpPath as NSString).appendingPathComponent(fileName)
        let vPath: String = DMPFileUtil.vPathFromSandboxPath(sandboxPath: videoPath, appId: appId)
        
        if compress {
            // 压缩视频
            return compressVideo(sourceURL: url, destinationPath: videoPath, vPath: vPath, width: width, height: height, duration: duration)
        } else {
            // 直接复制视频文件
            do {
                try FileManager.default.copyItem(at: url, to: URL(fileURLWithPath: videoPath))
                return DMPVideoFileModel(path: videoPath, size: fileSize, vPath: vPath, duration: duration, height: height, width: width)
            } catch {
                DMPLogger.debug("Failed to copy video file: \(error.localizedDescription)")
                return nil
            }
        }
    }
    
    // 压缩视频
    private static func compressVideo(sourceURL: URL, destinationPath: String, vPath: String, width: Int, height: Int, duration: Int) -> DMPVideoFileModel? {
        let destinationURL = URL(fileURLWithPath: destinationPath)
        
        // 视频压缩设置
        let compressQuality = AVAssetExportPresetMediumQuality
        
        let avAsset = AVAsset(url: sourceURL)
        
        guard let exportSession = AVAssetExportSession(asset: avAsset, presetName: compressQuality) else {
            DMPLogger.debug("Failed to create export session")
            return nil
        }
        
        exportSession.outputURL = destinationURL
        exportSession.outputFileType = .mp4
        exportSession.shouldOptimizeForNetworkUse = true
        
        // 使用信号量来等待异步操作完成
        let semaphore = DispatchSemaphore(value: 0)
        
        var videoFileModel: DMPVideoFileModel? = nil
        
        exportSession.exportAsynchronously {
            switch exportSession.status {
            case .completed:
                // 获取压缩后的文件大小
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: destinationPath),
                      let fileSize = attrs[.size] as? Int else {
                    DMPLogger.debug("Failed to get compressed video file size")
                    semaphore.signal()
                    return
                }
                
                videoFileModel = DMPVideoFileModel(path: destinationPath, size: fileSize, vPath: vPath, duration: duration, height: height, width: width)
                
            case .failed:
                DMPLogger.debug("Export failed: \(String(describing: exportSession.error))")
                
            case .cancelled:
                DMPLogger.debug("Export cancelled")
                
            default:
                DMPLogger.debug("Export unknown status: \(exportSession.status.rawValue)")
            }
            
            semaphore.signal()
        }
        
        // 最多等待30秒
        _ = semaphore.wait(timeout: .now() + 30)
        
        return videoFileModel
    }
    
    // 生成视频缩略图
    public static func createVideoThumbnail(from url: URL) -> UIImage? {
        let asset = AVAsset(url: url)
        let imageGenerator = AVAssetImageGenerator(asset: asset)
        imageGenerator.appliesPreferredTrackTransform = true
        
        // 取视频第一帧作为缩略图
        let time = CMTimeMake(value: 0, timescale: 1)
        
        do {
            let cgImage = try imageGenerator.copyCGImage(at: time, actualTime: nil)
            return UIImage(cgImage: cgImage)
        } catch {
            DMPLogger.debug("Failed to generate thumbnail: \(error.localizedDescription)")
            return nil
        }
    }
    
    // 创建视频缩略图并保存
    public static func createVideoThumbnailFile(from url: URL, appId: String) -> String? {
        guard let thumbnailImage = createVideoThumbnail(from: url),
              let imageFileModel = createTemporaryImagePath(image: thumbnailImage, appId: appId) else {
            return nil
        }
        
        return imageFileModel.vPath
    }
}


public class DMPImageFileModel {
    let path:String
    let size:Int
    let vPath:String

    init(path: String, size: Int, vPath: String) {
        self.path = path
        self.size = size
        self.vPath = vPath
    }
}


public class DMPVideoFileModel {
    let path:String
    let vPath:String
    let size:Int
    let duration:Int
    let height:Int
    let width:Int

    init(path: String, size: Int, vPath: String, duration: Int, height: Int, width: Int) {
        self.path = path
        self.vPath = vPath
        self.size = size
        self.duration = duration
        self.height = height
        self.width = width
    }
}

