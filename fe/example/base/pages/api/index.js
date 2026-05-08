Page({
  openSystemBluetoothSetting: function () {
    wx.openSystemBluetoothSetting({
      success(res) {
        console.log(res)
      }
    })
  },
  getMenuButtonBoundingClientRect: function() {
    const res = wx.getMenuButtonBoundingClientRect()
    console.log(res.width)
    console.log(res.height)
    console.log(res.top)
    console.log(res.right)
    console.log(res.bottom)
    console.log(res.left)
  },
  reLaunch: function() {
    wx.reLaunch({
      url: '/pages/scroll-view/index'
    })
  },
  setNavigationBarTitle: function() {
    wx.setNavigationBarTitle({
      title: '当前页面'
    })
  },
  setNavigationBarColor: function() {
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#ff0000',
      animation: {
        duration: 400,
        timingFunc: 'easeIn'
      }
    })
  },
  getWindowInfo: function () {
    const windowInfo = wx.getWindowInfo()

    console.log(windowInfo.pixelRatio)
    console.log(windowInfo.screenWidth)
    console.log(windowInfo.screenHeight)
    console.log(windowInfo.windowWidth)
    console.log(windowInfo.windowHeight)
    console.log(windowInfo.statusBarHeight)
    console.log(windowInfo.safeArea)
    console.log(windowInfo.screenTop)
  },
  getSystemSetting: function () {
    const systemSetting = wx.getSystemSetting()

    console.log(systemSetting.bluetoothEnabled)
    console.log(systemSetting.deviceOrientation)
    console.log(systemSetting.locationEnabled)
    console.log(systemSetting.wifiEnabled)
  },
  getSystemInfoSync: function () {
    const res = wx.getSystemInfoSync()
    console.log(res.model)
    console.log(res.pixelRatio)
    console.log(res.windowWidth)
    console.log(res.windowHeight)
    console.log(res.language)
    console.log(res.version)
    console.log(res.platform)
  },
  getSystemInfoAsync: function () {
    wx.getSystemInfoAsync({
      success(res) {
        console.log(res.model)
        console.log(res.pixelRatio)
        console.log(res.windowWidth)
        console.log(res.windowHeight)
        console.log(res.language)
        console.log(res.version)
        console.log(res.platform)
      }
    })
  },
  getSystemInfo: async function () {
    const result = await wx.getSystemInfo()
    console.log(result)
    wx.getSystemInfo({
      success(res) {
        console.log(res.model)
        console.log(res.pixelRatio)
        console.log(res.windowWidth)
        console.log(res.windowHeight)
        console.log(res.language)
        console.log(res.version)
        console.log(res.platform)
      }
    })
  },

  getStorage: function () {
    wx.setStorage({
      key: "key",
      data: "value",
      success() {
        wx.getStorage({
          key: "key",
          success(res) {
            console.log('getStorage', res.data)
          }
        })
      }
    })
  },
  setStorageSync: function () {
    wx.setStorageSync('key', 'value')
  },
  getStorageSync: function () {
    var value = wx.getStorageSync('key')
    console.log('getStorageSync', value);
  },
  removeStorageSync: function () {
    wx.removeStorageSync('key')
  },
  clearStorageSync: function () {
    wx.clearStorageSync()
  },
  setStorage: function () {
    wx.setStorage({
      key: "key",
      data: "value"
    })
  },
  getStorage: function () {
    wx.getStorage({
      key: 'key',
      success(res) {
        console.log(res.data)
      }
    })
  },
  removeStorage: function () {
    wx.removeStorage({
      key: 'key',
      success(res) {
        console.log(res)
      }
    })
  },
  clearStorage: function () {
    wx.clearStorage()
  },
  getStorageInfoSync: function () {
    const res = wx.getStorageInfoSync()
    console.log(res.keys)
    console.log(res.currentSize)
    console.log(res.limitSize)
  },
  getStorageInfo: function () {
    wx.getStorageInfo({
      success(res) {
        console.log(res.keys)
        console.log(res.currentSize)
        console.log(res.limitSize)
      }
    })
  },
  getNetworkType: function () {
    wx.getNetworkType({
      success(res) {
        const networkType = res.networkType;
        console.log('networkType', networkType);
      }
    });
  },
  startLocationUpdate: function () {
    wx.startLocationUpdate({
      type: 'gcj02',
      success: function (res) {
        console.log('startLocationUpdate success', res);
      },
      fail: function (res) {
        console.log('startLocationUpdate fail', res);
      },
      complete: function (res) {
        console.log('startLocationUpdate complete', res);
      },
    })
  },
  stopLocationUpdate: function () {
    wx.stopLocationUpdate({
      success: function (res) {
        console.log('stopLocationUpdate success', res);
      },
      fail: function (res) {
        console.log('stopLocationUpdate fail', res);
      },
      complete: function (res) {
        console.log('stopLocationUpdate complete', res);
      },
    })
  },
  showToast: function () {
    wx.showToast({
      title: '成功',
      icon: 'success',
      duration: 2000
    })
  },
  hideToast: function() {
    wx.hideToast()
  },
  showLoading: function () {
    wx.showLoading({
      title: '加载中',
    })
  },
  showModal: function () {
    wx.showModal({
      title: '提示',
      content: '这是一个模态弹窗',
      success(res) {
        console.log(res)
        if (res.confirm) {
          console.log('用户点击确定')
        } else if (res.cancel) {
          console.log('用户点击取消')
        }
      }
    })
  },
  pageScrollTo: function () {
    wx.pageScrollTo({
      scrollTop: 0,
      duration: 300
    })
  },
  request: function () {
    wx.request({
      url: 'https://suggest.taobao.com/sug?code=utf-8&q=%E7%9B%B8%E6%9C%BA',
      success(res) {
        console.log('get success', res);
      },
      fail(res) {
        console.log('get fail', res);
      },
      complete() {
        console.log('get complete')
      }
    });
    wx.request({
      url: 'http://httpbin.org/get',
      data: {name: 'John', age: 30},
      success(res) {
        console.log('get data success', typeof res, res);
      },
      fail(res) {
        console.log('get data fail', res);
      },
      complete() {
        console.log('get data complete')
      }
    });
    
    // POST request to httpbin.org
    wx.request({
      url: 'http://httpbin.org/post',
      method: 'POST',
      data: {
        name: 'John',
        age: 30,
        city: 'New York'
      },
      header: {
        'content-type': 'application/json'
      },
      success(res) {
        console.log('post success', res);
      },
      fail(res) {
        console.log('post fail', res);
      },
      complete() {
        console.log('post complete')
      }
    });
  },
  downloadFile: function () {
    wx.downloadFile({
      url: 'https://picsum.photos/200/200',
      success(res) {
        console.log(res.tempFilePath)
      }
    })
  },
  uploadFile: function () {
    wx.chooseImage({
      success(res) {
        const tempFilePaths = res.tempFilePaths
        wx.uploadFile({
          url: 'https://example.weixin.qq.com/upload',
          filePath: tempFilePaths[0],
          name: 'file',
          formData: {
            'user': 'test'
          },
          success(res) {
            console.log(res.data)
          }
        })
      }
    })
  },
  setClipboardData: function () {
    wx.setClipboardData({
      data: 'data',
      success(res) {
        console.log(res)
      }
    })
  },
  getClipboardData: function () {
    wx.getClipboardData({
      success(res) {
        console.log(res.data)
      }
    })
  },
  makePhoneCall: function () {
    wx.makePhoneCall({
      phoneNumber: '1340000'
    })
  },
  chooseContact: function() {
    wx.chooseContact({
      success(res) {
        console.log(res)
      },
      fail(res) {
        console.log(res)
      },
      complete() {
        console.log("complete")
      }
    })
  },
  addPhoneContact: function() {
    wx.addPhoneContact({
      firstName: 'firstName',
      mobilePhoneNumber: '12306'
    })
  },
  previewImage: function() {
    wx.previewImage({
      urls: ["https://picsum.photos/200/200","https://picsum.photos/800/600"],
    })
  },
  chooseImage: function() {
    wx.chooseImage({
      count: 2,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success (res) {
        const tempFilePaths = res.tempFilePaths
        wx.saveImageToPhotosAlbum({
          filePath: tempFilePaths[0],
          success(res) {
            console.log('save', res)
           }
        })

        wx.compressImage({
          src: tempFilePaths[0],
          quality: 80,
          success(res) {
            console.log('compress', res)
          }
        })
      }
    })
  },
  chooseMedia: function() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image','video'],
      sourceType: ['album', 'camera'],
      maxDuration: 30,
      camera: 'back',
      success(res) {
        console.log(res.tempFiles[0].tempFilePath)
        console.log(res.tempFiles[0].size)
      }
    })
  },
  vibrateLong: function() {
    wx.vibrateLong({})
  },
  vibrateShort: function() {
    wx.vibrateShort()
  },
  showActionSheet: function() {
    wx.showActionSheet({
      itemList: ['A', 'B', 'C'],
      success (res) {
        console.log(res.tapIndex)
      },
      fail (res) {
        console.log(res.errMsg)
      }
    })
  },
  scanCode: function() {
    wx.scanCode({
      success (res) {
        console.log(res)
      }
    })
  }
});