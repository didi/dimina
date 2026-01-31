Page({
  data: {
    statusBarHeight: 0,
    navBarHeight: 0,
    safeHeight: 0,
    bottomSafeHeight: 0,
  },
  onLoad() {
    // 获取的数值单位是px
    /*
    const windowInfo = wx.getWindowInfo();
    const menuButtonInfo = wx.getMenuButtonBoundingClientRect();
    console.log(windowInfo);
    console.log(menuButtonInfo);

    let statusBarHeight = windowInfo.statusBarHeight;
    let navBarHeight =
      menuButtonInfo.height + (menuButtonInfo.top - statusBarHeight) * 2;
    let safeHeight = windowInfo.safeArea.height;
    let bottomSafeHeight =
      windowInfo.screenHeight - windowInfo.safeArea.height - statusBarHeight;
    this.setData({
      statusBarHeight,
      navBarHeight,
      safeHeight,
      bottomSafeHeight,
    });
    console.log("statusBarHeight", statusBarHeight);
    console.log("navBarHeight", navBarHeight);
    console.log("safeHeight", safeHeight);
    console.log("bottomSafeHeight", bottomSafeHeight);
    */



  },
  //获取状态栏高度
  get_h() {
    // 获取的数值单位是px
    const windowInfo = wx.getWindowInfo();

    console.log("获取状态栏1",windowInfo);

    let statusBarHeight = windowInfo.statusBarHeight;
    let safeHeight = windowInfo.safeArea.height;
    let bottomSafeHeight = windowInfo.screenHeight - windowInfo.safeArea.height - statusBarHeight;
    // this.setData({
    //   statusBarHeight,
    //   navBarHeight,
    //   safeHeight,
    //   bottomSafeHeight,
    // });
    console.log("获取状态栏3","statusBarHeight", statusBarHeight);
    console.log("获取状态栏5","safeHeight", safeHeight);
    console.log("获取状态栏6","bottomSafeHeight", bottomSafeHeight);

    const menuButtonInfo = wx.getMenuButtonBoundingClientRect();
    console.log("获取状态栏2",menuButtonInfo);
    if(menuButtonInfo){
      let navBarHeight = menuButtonInfo.height + (menuButtonInfo.top - statusBarHeight) * 2;
      console.log("获取状态栏4","navBarHeight", navBarHeight);

    }


  },
  
});


