
Page({
  mixins: [require('../mixin/common')],
  TAG: "WEAPI_APP",
  data: {
    sw1: true,
    sw2: false,
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

  },
  b1(e) {
    console.log('测试 开关', e);
    this.setData({
      sw2: e.detail.value
    }
    )

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

  //打开蓝牙小程序
  goToopenapp() {
    wx.navigateToMiniProgram({
      appId: 'wxc77007cc301be278',
      path: 'pages/index/index?from=我的小程序&userId=123',
      extraData: {
        source: 'demoMiniProgram',
        timestamp: Date.now()
      },
      envVersion: 'release',
      success(res) {
        console.log('打开小程序成功', res);
      },
      // 失败回调（比如白名单配置错误、appid错误等）
      fail(err) {
        console.error('打开小程序失败', err);
        wx.showToast({
          title: '打开失败：' + err.errMsg,
          icon: 'none',
          duration: 3000
        });
      },
      // 完成回调（无论成功/失败都会执行）
      complete() {
        console.log('打开小程序操作完成');
      }
    });
  },


  //测试api
  testapi() {



    var a = wx.UDP_test(123)
    console.log('测试 UDP_test 返回', a);
  },
  onLoad() {
    console.log('设置背景颜色');
    wx.setNavigationBarColor({
      frontColor: '#ffffff',       // 文字和按钮颜色（白色）
      backgroundColor: '#ff0000',  // 背景颜色（红色）
      animation: {                 // 可选：颜色切换动画
        duration: 400,             // 动画时长（毫秒）
        timingFunc: 'easeIn'
      },
      success() {
        console.log('导航栏颜色设置成功');
      },
      fail(err) {
        console.error('设置失败', err);
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

