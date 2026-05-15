//包管理日志TAG集合
export class Tags {
  //---------包管理模块--------

  //包管理根日志
  static BUNDLE = "[bundle]"
  //加载本地包日志
  static LOAD_LOCAL_BUNDLE = Tags.BUNDLE + "[loadLocal]"
  //加载远程包日志
  static LOAD_REMOTE_BUNDLE = Tags.BUNDLE + "[loadRemote]"
  //加载gift包日志
  static LOAD_GIFT_BUNDLE = Tags.BUNDLE + "[loadGift]"
  //加载debugUrl包日志
  static LOAD_DEBUG_BUNDLE = Tags.BUNDLE + "[loadDebug]"
  //加载缓存配置
  static LOAD_CACHE_CONFIG = Tags.BUNDLE + "[loadCacheConfig]"
  //预加载远程包
  static LOAD_PREV_REMOTE_BUNDLE = Tags.LOAD_REMOTE_BUNDLE + "[prev]"
  //文件管理
  static FILE_MANAGER = Tags.BUNDLE + "[fileManager]"
  //下载管理
  static DOWNLOAD_MANAGER = Tags.BUNDLE + "[downloadManager]"
  //子包管理
  static SUB_PKG_MANAGER = Tags.BUNDLE + "[subpackage]"
  //----------启动流程---------
  //启动流程日志
  static LAUNCH = "[launch-container]"
  //核心日志
  static DIMINA_CORE = "[diminaCore]"
  //bridge 通信
  static BRIDGE = "[d-bridges]"
  //导航器
  static NAVIGATOR = "[navigator]"
  //重定向
  static REDIRECT = Tags.NAVIGATOR + "[redirect]"
  //页面onShow
  static ON_PAGE_SHOW = Tags.NAVIGATOR +'[onPageShow]'
  //页面onHide
  static ON_PAGE_HIDE = Tags.NAVIGATOR +'[onPageHide]'
  //---------地图模块----------
  static MAP = "[map]"
  //同层渲染webview
  static EMBED_WEB_VIEW = "[embedWebView]"
  //地图气泡
  static MAP_BUBBLE = "[map][bubble]"
  //预加载
  static PRE_LOAD = '[preLoad]'
  //页面
  static DMP_WEB_COMPONENT = "[DMPWebComponent]" + Tags.PRE_LOAD

  static DMP_PAGE = "[dmpPage]"
  //web容器
  static WEB_COMPONENT = "[webComponent]"
  //定位
  static LOCATION = "[location]"
  //生命周期
  static APP_LIFECYCLE = "[appLifecycle]"
  static NETWORK = "[network]"
  static RENDER = '[render]'
  static JS_ENGINE = '[QuickJS]'

  static STAR_BOX = '[StarBox]'
  //TabBar
  static TABBAR = '[tabBar]'

}
