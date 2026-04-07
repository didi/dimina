//
//  ContactAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import Contacts
import ContactsUI

/**
 * Device - Contact API
 */
public class ContactAPI: DMPContainerApi {
    
    // API method names
    private static let CHOOSE_CONTACT = "chooseContact"
    private static let ADD_PHONE_CONTACT = "addPhoneContact"
    
    // Choose contact
    @BridgeMethod(CHOOSE_CONTACT)
    var chooseContact: DMPBridgeMethodHandler = { param, env, callback in
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex),
              let navigator = app.getNavigator(),
              let navController = navigator.navigationController else {
            let result = DMPMap()
            result.set("errMsg", "\(CHOOSE_CONTACT):fail")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "无法获取导航控制器")
            return DMPAsyncResult()
        }
        
        DispatchQueue.main.async {
            let contactPicker = CNContactPickerViewController()
            contactPicker.delegate = ContactPickerDelegate.shared
            
            // 设置回调
            ContactPickerDelegate.shared.completion = { contact in
                let result = DMPMap()
                
                if let contact = contact {
                    // 获取联系人姓名
                    let displayName = CNContactFormatter.string(from: contact, style: .fullName) ?? ""
                    
                    // 获取所有电话号码
                    var phoneNumberList: [String] = []
                    var phoneNumber = ""
                    
                    for phoneNumberValue in contact.phoneNumbers {
                        let number = phoneNumberValue.value.stringValue.replacingOccurrences(of: "[^0-9+]", with: "", options: .regularExpression)
                        phoneNumberList.append(number)
                        
                        if phoneNumber.isEmpty {
                            phoneNumber = number
                        }
                    }
                    
                    result.set("phoneNumber", phoneNumber)
                    result.set("displayName", displayName)
                    result.set("phoneNumberList", phoneNumberList)
                    result.set("errMsg", "\(CHOOSE_CONTACT):ok")
                    
                    DMPContainerApi.invokeSuccess(callback: callback, param: result)
                } else {
                    result.set("errMsg", "\(CHOOSE_CONTACT):fail cancel")
                    DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "用户取消选择")
                }
            }
            
            navController.present(contactPicker, animated: true)
        }
        
        return DMPAsyncResult()
    }

    // Add phone contact
    @BridgeMethod(ADD_PHONE_CONTACT)
    var addPhoneContact: DMPBridgeMethodHandler = { param, env, callback in
        // 检查是否有必要的权限
        let authStatus = CNContactStore.authorizationStatus(for: .contacts)
        
        if authStatus != .authorized {
            CNContactStore().requestAccess(for: .contacts) { granted, error in
                if granted {
                    ContactAPI.createContact(param: param.getMap(), callback: callback)
                } else {
                    DispatchQueue.main.async {
                        let result = DMPMap()
                        result.set("errMsg", "\(ADD_PHONE_CONTACT):fail auth denied")
                        DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "没有通讯录权限")
                    }
                }
            }
        } else {
            ContactAPI.createContact(param: param.getMap(), callback: callback)
        }

        return DMPAsyncResult()
    }
    
    // 辅助方法：创建联系人
    private static func createContact(param: DMPMap, callback: DMPBridgeCallback?) {
        // 确保有必填字段
        guard let firstName = param.getString(key: "firstName") else {
            let result = DMPMap()
            result.set("errMsg", "\(ADD_PHONE_CONTACT):fail missing required fields")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "缺少必填字段")
            return
        }
        
        let contact = CNMutableContact()
        
        // 设置姓名
        contact.givenName = firstName
        contact.familyName = param.getString(key: "lastName") ?? ""
        contact.middleName = param.getString(key: "middleName") ?? ""
        contact.nickname = param.getString(key: "nickName") ?? ""
        
        // 设置电话号码
        if let mobilePhoneNumber = param.getString(key: "mobilePhoneNumber") {
            let mobilePhone = CNLabeledValue(
                label: CNLabelPhoneNumberMobile,
                value: CNPhoneNumber(stringValue: mobilePhoneNumber)
            )
            contact.phoneNumbers.append(mobilePhone)
        }
        
        if let workPhoneNumber = param.getString(key: "workPhoneNumber") {
            let workPhone = CNLabeledValue(
                label: CNLabelWork,
                value: CNPhoneNumber(stringValue: workPhoneNumber)
            )
            contact.phoneNumbers.append(workPhone)
        }
        
        if let homePhoneNumber = param.getString(key: "homePhoneNumber") {
            let homePhone = CNLabeledValue(
                label: CNLabelHome,
                value: CNPhoneNumber(stringValue: homePhoneNumber)
            )
            contact.phoneNumbers.append(homePhone)
        }
        
        // 设置传真号码
        if let workFaxNumber = param.getString(key: "workFaxNumber") {
            let workFax = CNLabeledValue(
                label: CNLabelWork,
                value: CNPhoneNumber(stringValue: workFaxNumber)
            )
            contact.phoneNumbers.append(workFax)
        }
        
        if let homeFaxNumber = param.getString(key: "homeFaxNumber") {
            let homeFax = CNLabeledValue(
                label: CNLabelHome,
                value: CNPhoneNumber(stringValue: homeFaxNumber)
            )
            contact.phoneNumbers.append(homeFax)
        }
        
        // 设置其他联系信息
//        if let weChatNumber = param.getString(key: "weChatNumber") {
//            let wechat = CNLabeledValue(
//                label: "WeChat",
//                value: weChatNumber as NSString
//            )
//            contact.socialProfiles.append(wechat)
//        }
        
        // 设置电子邮件
        if let email = param.getString(key: "email") {
            let emailValue = CNLabeledValue(
                label: CNLabelWork,
                value: email as NSString
            )
            contact.emailAddresses.append(emailValue)
        }
        
        // 设置URL
        if let url = param.getString(key: "url") {
            let urlValue = CNLabeledValue(
                label: CNLabelWork,
                value: url as NSString
            )
            contact.urlAddresses.append(urlValue)
        }
        
        // 设置组织和职位
        if let organization = param.getString(key: "organization") {
            contact.organizationName = organization
        }
        
        if let title = param.getString(key: "title") {
            contact.jobTitle = title
        }
        
        // 设置备注
        if let remark = param.getString(key: "remark") {
            contact.note = remark
        }
        
        // 设置头像
        if let photoFilePath = param.getString(key: "photoFilePath") {
            if let imageData = try? Data(contentsOf: URL(fileURLWithPath: photoFilePath)) {
                contact.imageData = imageData
            }
        }
        
        // 设置住宅地址
        var homeAddress = CNMutablePostalAddress()
        var hasHomeAddress = false
        
        if let homeAddressCountry = param.getString(key: "homeAddressCountry") {
            homeAddress.country = homeAddressCountry
            hasHomeAddress = true
        }
        
        if let homeAddressState = param.getString(key: "homeAddressState") {
            homeAddress.state = homeAddressState
            hasHomeAddress = true
        }
        
        if let homeAddressCity = param.getString(key: "homeAddressCity") {
            homeAddress.city = homeAddressCity
            hasHomeAddress = true
        }
        
        if let homeAddressStreet = param.getString(key: "homeAddressStreet") {
            homeAddress.street = homeAddressStreet
            hasHomeAddress = true
        }
        
        if let homeAddressPostalCode = param.getString(key: "homeAddressPostalCode") {
            homeAddress.postalCode = homeAddressPostalCode
            hasHomeAddress = true
        }
        
        if hasHomeAddress {
            let homeAddressValue = CNLabeledValue<CNPostalAddress>(
                label: CNLabelHome,
                value: homeAddress
            )
            contact.postalAddresses.append(homeAddressValue)
        }
        
        // 设置工作地址
        var workAddress = CNMutablePostalAddress()
        var hasWorkAddress = false
        
        if let workAddressCountry = param.getString(key: "workAddressCountry") {
            workAddress.country = workAddressCountry
            hasWorkAddress = true
        }
        
        if let workAddressState = param.getString(key: "workAddressState") {
            workAddress.state = workAddressState
            hasWorkAddress = true
        }
        
        if let workAddressCity = param.getString(key: "workAddressCity") {
            workAddress.city = workAddressCity
            hasWorkAddress = true
        }
        
        if let workAddressStreet = param.getString(key: "workAddressStreet") {
            workAddress.street = workAddressStreet
            hasWorkAddress = true
        }
        
        if let workAddressPostalCode = param.getString(key: "workAddressPostalCode") {
            workAddress.postalCode = workAddressPostalCode
            hasWorkAddress = true
        }
        
        if hasWorkAddress {
            let workAddressValue = CNLabeledValue<CNPostalAddress>(
                label: CNLabelWork,
                value: workAddress
            )
            contact.postalAddresses.append(workAddressValue)
        }
        
        // 添加联系人
        let store = CNContactStore()
        let saveRequest = CNSaveRequest()
        saveRequest.add(contact, toContainerWithIdentifier: nil)
        
        do {
            try store.execute(saveRequest)
            let result = DMPMap()
            result.set("errMsg", "\(ADD_PHONE_CONTACT):ok")
            DMPContainerApi.invokeSuccess(callback: callback, param: result)
        } catch {
            let result = DMPMap()
            result.set("errMsg", "\(ADD_PHONE_CONTACT):fail \(error.localizedDescription)")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: error.localizedDescription)
        }
    }
}

// 联系人选择器代理
class ContactPickerDelegate: NSObject, CNContactPickerDelegate {
    static let shared = ContactPickerDelegate()
    
    var completion: ((CNContact?) -> Void)?
    
    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        picker.dismiss(animated: true)
        completion?(nil)
    }
    
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        picker.dismiss(animated: true)
        completion?(contact)
    }
}
