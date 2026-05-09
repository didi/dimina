//
//  InteractionAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * UI - Interaction API
 */
public class InteractionAPI: DMPContainerApi {
    
    // API method names
    private static let SHOW_TOAST = "showToast"
    private static let SHOW_MODAL = "showModal"
    private static let SHOW_LOADING = "showLoading"
    private static let HIDE_TOAST = "hideToast"
    private static let HIDE_LOADING = "hideLoading"
    private static let SHOW_ACTION_SHEET = "showActionSheet"
    
    // Show toast
    @BridgeMethod(SHOW_TOAST)
    var showToast: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取必需参数
        guard let title = param.get("title") as? String else {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(InteractionAPI.SHOW_TOAST):fail title is required")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "title is required")
            return DMPAsyncResult()
        }
        
        // 获取可选参数
        let icon = param.get("icon") as? String ?? "success"
        let duration = param.get("duration") as? Int ?? 1500
        let mask = param.get("mask") as? Bool ?? false
        
        // 在主线程上显示 Toast
        DispatchQueue.main.async {
            // 将 icon 参数转换为 ToastType
            var toastType: ToastType = .success
            switch icon {
            case "success":
                toastType = .success
            case "error":
                toastType = .error
            case "loading":
                toastType = .loading
            case "none":
                toastType = .none
            default:
                toastType = .success
            }
            
            // 显示 Toast
            ToastManager.shared.showToast(title: title, type: toastType, duration: duration, mask: mask)
        }
        
        // 返回成功响应
        let result = DMPMap()
        result.set("errMsg", "\(InteractionAPI.SHOW_TOAST):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
    
    // Show modal
    @BridgeMethod(SHOW_MODAL)
    var showModal: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取可选参数
        let title = param.get("title") as? String ?? ""
        let content = param.get("content") as? String ?? ""
        let showCancel = param.get("showCancel") as? Bool ?? true
        let cancelText = param.get("cancelText") as? String ?? "取消"
        let cancelColor = param.get("cancelColor") as? String ?? "#000000"
        let confirmText = param.get("confirmText") as? String ?? "确定"
        let confirmColor = param.get("confirmColor") as? String ?? "#576B95"
        
        // 在主线程上显示对话框
        DispatchQueue.main.async {
            // 调用 ModalManager 显示对话框
            ModalManager.shared.showModal(
                title: title,
                content: content,
                showCancel: showCancel,
                cancelText: cancelText,
                cancelColor: cancelColor,
                confirmText: confirmText,
                confirmColor: confirmColor
            ) { isConfirmed in
                // 返回结果
                let result = DMPMap()
                result.set("confirm", isConfirmed)
                result.set("cancel", !isConfirmed)
                result.set("errMsg", "\(InteractionAPI.SHOW_MODAL):ok")
                DMPContainerApi.invokeSuccess(callback: callback, param: result)
            }
        }
        return DMPAsyncResult()
    }
    
    // Show loading
    @BridgeMethod(SHOW_LOADING)
    var showLoading: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取必需参数
        guard let title = param.get("title") as? String else {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(InteractionAPI.SHOW_LOADING):fail title is required")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "title is required")
            return DMPAsyncResult()
        }
        
        // 获取可选参数
        let mask = param.get("mask") as? Bool ?? false
        
        // 在主线程上显示加载指示器
        DispatchQueue.main.async {
            // 使用 loading 图标，不会自动消失（无限时间）
            ToastManager.shared.showToast(title: title, type: .loading, duration: 0, mask: mask)
        }
        
        // 返回成功响应
        let result = DMPMap()
        result.set("errMsg", "\(InteractionAPI.SHOW_LOADING):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
    
    // Hide toast
    @BridgeMethod(HIDE_TOAST)
    var hideToast: DMPBridgeMethodHandler = { param, env, callback in
        // 在主线程上隐藏 Toast
        DispatchQueue.main.async {
            ToastManager.shared.hideToast()
        }
        
        // 返回成功响应
        let result = DMPMap()
        result.set("errMsg", "\(InteractionAPI.HIDE_TOAST):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
    
    // Hide loading
    @BridgeMethod(HIDE_LOADING)
    var hideLoading: DMPBridgeMethodHandler = { param, env, callback in
        // 在主线程上隐藏加载指示器
        DispatchQueue.main.async {
            // 隐藏加载指示器（使用 ToastManager 的 hideToast 方法）
            ToastManager.shared.hideToast()
        }
        
        // 返回成功响应
        let result = DMPMap()
        result.set("errMsg", "\(InteractionAPI.HIDE_LOADING):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
    
    // Show action sheet
    @BridgeMethod(SHOW_ACTION_SHEET)
    var showActionSheet: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取可选参数
        let itemColor = param.get("itemColor") as? String ?? "#000000"
        
        // 获取选项列表
        var itemList: [String] = []
        if let items = param.get("itemList") as? [String] {
            itemList = items
        } else if let items = param.get("itemList") as? [Any] {
            itemList = items.compactMap { item in
                if let str = item as? String {
                    return str
                }
                return nil
            }
        }
        
        // 如果选项列表为空，返回错误
        if itemList.isEmpty {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(InteractionAPI.SHOW_ACTION_SHEET):fail itemList is empty")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "itemList is empty")
            return DMPAsyncResult()
        }
        
        // 在主线程上显示操作表
        DispatchQueue.main.async {
            // 调用 ActionSheetManager 显示操作表
            ActionSheetManager.shared.showActionSheet(
                itemList: itemList,
                itemColor: itemColor
            ) { selectedIndex in
                // 返回结果
                let result = DMPMap()
                result.set("tapIndex", selectedIndex)
                result.set("errMsg", "\(InteractionAPI.SHOW_ACTION_SHEET):ok")
                DMPContainerApi.invokeSuccess(callback: callback, param: result)
            }
        }
        return DMPAsyncResult()
    }
    
}
