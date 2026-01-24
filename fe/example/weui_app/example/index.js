
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

