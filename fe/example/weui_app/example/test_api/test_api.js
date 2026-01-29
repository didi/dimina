
Page({
  mixins: [require('../mixin/common')],
  data: {
    list: [
      {
        id: 'form',
        name: '表单',
        open: false,
        pages: ['button', 'form', 'list', 'slideview', 'slider', 'uploader'],
      },
      {
        id: 'layout',
        name: '基础组件',
        open: false,
        pages: ['article', 'badge', 'flex', 'footer', 'gallery', 'grid', 'icons', 'loading', 'loadmore', 'panel', 'preview', 'progress', 'steps'],
      },
      {
        id: 'feedback',
        name: '操作反馈',
        open: false,
        pages: ['actionsheet', 'dialog', 'half-screen-dialog', 'msg', 'picker', 'toast', 'information-bar'],
      },
      {
        id: 'nav',
        name: '导航相关',
        open: false,
        pages: ['navigation-bar', 'tabbar'],
      },
      {
        id: 'search',
        name: '搜索相关',
        open: false,
        pages: ['searchbar'],
      },
    ],
    // 新增：存储API测试结果
    apiTestResults: [],
    testData: {
      storageValue: '',
      networkType: '',
      systemInfo: {}
    }
  },

  onLoad() {
    // 页面加载时自动测试一些基础API
    this.testBasicAPIs();
  },

  // ========== 基础API测试 ==========

  // 1. 网络请求测试
  testRequest() {
    wx.request({
      url: 'https://httpbin.org/get',
      method: 'GET',
      success: (res) => {
        this.addTestResult('网络请求', '成功', res.data);
        wx.showToast({ title: '请求成功', icon: 'success' });
      },
      fail: (error) => {
        this.addTestResult('网络请求', '失败', error);
        wx.showToast({ title: '请求失败', icon: 'none' });
      }
    });
  },

  // 2. 本地存储测试
  testStorage() {
    const testData = { time: new Date().toLocaleString(), random: Math.random() };

    // 写入存储
    wx.setStorage({
      key: 'testKey',
      data: testData,
      success: () => {
        // 读取存储
        wx.getStorage({
          key: 'testKey',
          success: (res) => {
            this.addTestResult('本地存储', '读写成功', res.data);
            this.setData({
              'testData.storageValue': JSON.stringify(res.data)
            });
            wx.showToast({ title: '存储测试成功', icon: 'success' });
          },
          fail: (error) => {
            this.addTestResult('本地存储', '读取失败', error);
          }
        });
      },
      fail: (error) => {
        this.addTestResult('本地存储', '写入失败', error);
      }
    });
  },

  // 3. 设备信息获取
  testSystemInfo() {
    wx.getSystemInfo({
      success: (res) => {
        this.addTestResult('系统信息', '获取成功', {
          品牌: res.brand,
          型号: res.model,
          系统: res.system,
          平台: res.platform
        });
        this.setData({
          'testData.systemInfo': res
        });
        wx.showToast({ title: '获取系统信息成功', icon: 'success' });
      },
      fail: (error) => {
        this.addTestResult('系统信息', '获取失败', error);
      }
    });
  },

  // 4. 网络状态检测
  testNetworkType() {
    wx.getNetworkType({
      success: (res) => {
        this.addTestResult('网络类型', '检测成功', res.networkType);
        this.setData({
          'testData.networkType': res.networkType
        });
        wx.showToast({ title: `网络类型: ${res.networkType}`, icon: 'success' });
      },
      fail: (error) => {
        this.addTestResult('网络类型', '检测失败', error);
      }
    });
  },

  // 5. 设备振动测试
  testVibrate() {
    wx.vibrateShort({
      success: () => {
        this.addTestResult('设备振动', '振动成功', '短振动');
        wx.showToast({ title: '振动测试成功', icon: 'success' });
      },
      fail: (error) => {
        this.addTestResult('设备振动', '振动失败', error);
      }
    });
  },

  // 6. 剪贴板测试
  testClipboard() {
    const testText = `测试文本 ${new Date().toLocaleTimeString()}`;

    wx.setClipboardData({
      data: testText,
      success: () => {
        wx.getClipboardData({
          success: (res) => {
            this.addTestResult('剪贴板', '读写成功', `写入: ${testText}, 读取: ${res.data}`);
            wx.showToast({ title: '剪贴板测试成功', icon: 'success' });
          }
        });
      },
      fail: (error) => {
        this.addTestResult('剪贴板', '操作失败', error);
      }
    });
  },

  // ========== 界面交互API测试 ==========

  // 7. 显示加载提示
  testLoading() {
    wx.showLoading({
      title: '加载中...',
      mask: true
    });

    // 3秒后隐藏
    setTimeout(() => {
      wx.hideLoading();
      this.addTestResult('加载提示', '显示/隐藏成功', '3秒自动关闭');
    }, 3000);
  },

  // 8. 显示模态对话框
  testModal() {
    wx.showModal({
      title: '测试对话框',
      content: '这是一个测试模态对话框',
      showCancel: true,
      success: (res) => {
        const result = res.confirm ? '点击了确定' : '点击了取消';
        this.addTestResult('模态对话框', '操作成功', result);
      },
      fail: (error) => {
        this.addTestResult('模态对话框', '操作失败', error);
      }
    });
  },

  // 9. 显示动作菜单
  testActionSheet() {
    wx.showActionSheet({
      itemList: ['选项A', '选项B', '选项C'],
      success: (res) => {
        const index = res.tapIndex;
        this.addTestResult('动作菜单', '选择成功', `选择了第${index + 1}项`);
      },
      fail: (error) => {
        this.addTestResult('动作菜单', '操作失败', error);
      }
    });
  },

  // ========== 工具函数 ==========

  // 添加测试结果
  addTestResult(apiName, status, data) {
    const result = {
      time: new Date().toLocaleTimeString(),
      api: apiName,
      status: status,
      data: typeof data === 'object' ? JSON.stringify(data) : data
    };

    this.setData({
      apiTestResults: [result, ...this.data.apiTestResults.slice(0, 9)] // 只保留最近10条
    });

    console.log(`API测试 - ${apiName}:`, status, data);
  },

  // 清空测试结果
  clearTestResults() {
    this.setData({
      apiTestResults: []
    });
  },

  // 批量测试基础API
  testBasicAPIs() {
    this.testSystemInfo();
    this.testNetworkType();
    setTimeout(() => this.testStorage(), 1000);
  },

  // ========== 按钮事件 ==========
  but1() {
    console.log('点击按钮1 - 开始API测试');

    // 执行网络请求测试
    this.testRequest();
  },

  but2() {
    // 执行设备功能测试
    this.testVibrate();
    setTimeout(() => this.testClipboard(), 500);
  },

  but3() {
    // 执行界面交互测试
    this.testLoading();
    setTimeout(() => this.testModal(), 1500);
    setTimeout(() => this.testActionSheet(), 3000);
  },


  /**
  * 跳转到UDP示例页面
  */
  goToUdpExample() {
    // 先检查UDP示例页面是否存在
    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];

    console.log('跳转到UDP示例页面');

    // 方式1: 使用navigateTo跳转（推荐，保留当前页面）
    wx.navigateTo({
      url: '/example/udp/udp',
      success: (res) => {
        console.log('跳转成功', res);
      },
      fail: (err) => {
        console.error('跳转失败', err);
        this.fallbackToUdpPage();
      }
    });
  },


  // 原有的其他方法保持不变
  kindToggle(e) {
    const { id } = e.currentTarget;
    const { list } = this.data;
    for (let i = 0, len = list.length; i < len; ++i) {
      if (list[i].id == id) {
        list[i].open = !list[i].open;
      } else {
        list[i].open = false;
      }
    }
    this.setData({
      list,
    });
  },

  changeTheme() {
    const theme = this.data.theme === 'light' ? 'dark' : 'light';
    getApp().onThemeChange({ theme });
  },
});

