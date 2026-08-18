import contact from '@ohos.contact';
import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'
import { DMPMap } from '../Utils/DMPMap';
import { DMPLogger } from '../EventTrack/DMPLogger';


export class AddPhoneContactClass {
  firstName: string = '' // 名字
  photoFilePath?: string = '' // 头像本地文件路径
  nickName?: string = '' // 昵称
  lastName?: string = '' // 姓氏
  middleName?: string = '' // 中间名
  remark?: string = '' // 备注
  mobilePhoneNumber?: string = '' // 手机号
  weChatNumber?: string = '' // 微信号
  addressCountry?: string = '' // 联系地址国家
  addressState?: string = '' // 联系地址省份
  addressCity?: string = '' // 联系地址城市
  addressStreet?: string = '' // 联系地址街道
  addressPostalCode?: string = '' // 联系地址邮政编码
  organization?: string = '' // 公司
  title?: string = '' //	职位
  workFaxNumber?: string = '' // 工作传真
  workPhoneNumber?: string = '' // 工作电话
  hostNumber?: string = '' // 公司电话
  email?: string = '' //	电子邮件
  url?: string = '' // 网站
  workAddressCountry?: string = '' // 工作地址国家
  workAddressState?: string = '' // 工作地址省份
  workAddressCity?: string = '' // 工作地址城市
  workAddressStreet?: string = '' // 工作地址街道
  workAddressPostalCode?: string = '' // 工作地址邮政编码
  homeFaxNumber?: string = '' // 住宅传真
  homePhoneNumber?: string = '' // 住宅电话
  homeAddressCountry?: string = '' // 住宅地址国家
  homeAddressState?: string = '' // 住宅地址省份
  homeAddressCity?: string = '' // 住宅地址城市
  homeAddressStreet?: string = '' // 住宅地址街道
  homeAddressPostalCode?: string = '' //	住宅地址邮政编码
}


export class DMPContainerBridgesModuleContact extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['chooseContact', 'addPhoneContact'];
  }

  chooseContact(params: DMPMap, callback: DMPBridgeCallback) {
    const errHandler = (msg: string) => {
      let errData: DMPMap = new DMPMap();
      const errMsg: string = msg || '选择失败'
      errData.set('errMsg', errMsg)
      this.invokeFailureCallback(callback, errData, errMsg)
    }

    contact.selectContacts((err, data) => {
      if (err) {
        DMPLogger.d(`selectContact callback: err->${JSON.stringify(err)}`);
        // 异常回调统一处理？
        errHandler(err.message)
        return
      }

      // errHandler('测试异常')
      // return

      // [{"name":{"fullName":"测试通讯录"},"phoneNumbers":[{"phoneNumber":"17610835812"}]}]
      if (Array.isArray(data)) {
        let contactData: DMPMap = new DMPMap();
        if (data.length === 1) {
          const tempData = data[0]
          contactData.set('phoneNumber', tempData?.phoneNumbers?.[0].phoneNumber || '');
          contactData.set('displayName', tempData?.name?.fullName || '');
          contactData.set('phoneNumberList', tempData?.phoneNumbers?.[0].phoneNumber || '');

          DMPLogger.d(`djch selectContact callback: success data->${JSON.stringify(contactData)}`);
          // 使用异步？返回对象？
          this.invokeSuccessCallback(callback, contactData)
        } else if (data.length > 1) {
          DMPLogger.d('djch 部分安卓机型下，只能选择联系人，无法选择指定手机号，在鸿蒙下不会走到这里')
        }
      }
      DMPLogger.d(`djch selectContact callback: success data->${JSON.stringify(data)}`);
      // 异常信息统一处理，枚举？
      // errHandler('选择异常，请稍后重试')
    })
  }

  // 目前该接口需要 用户授权，还需要使用ACL配置权限：需要appId，目前没有
  // 查看更多：https://developer.harmonyos.com/cn/docs/documentation/doc-guides-V3/signing-0000001587684945-V3?catalogVersion=V3#section157591551175916
  addPhoneContact(params: AddPhoneContactClass) {
    if (params.firstName?.trim() == '') {
      DMPLogger.e('', '联系人姓名不能为空')
      return
    }
    DMPLogger.d('djch addPhoneContact 入参：', JSON.stringify(params))

    let promise = contact.addContact({
      phoneNumbers: [{
        phoneNumber: params.mobilePhoneNumber || ''
      }],
      name: {
        fullName: params.firstName,
        namePrefix: params.lastName
      },
      nickName: {
        nickName: params.nickName || ''
      }
    });

    DMPLogger.d('djch go to addPhoneContact before')
    promise.then((data) => {
      DMPLogger.d(`djch addContact success: data->${JSON.stringify(data)}`);
    }).catch((err: Error) => {
      DMPLogger.e('', `addContact failed: ${JSON.stringify(err)}`);
    });
  }
}
