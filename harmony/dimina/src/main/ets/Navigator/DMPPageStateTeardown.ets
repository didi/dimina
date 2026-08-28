/**
 * 拆掉整个页面栈的两种原因。微信里 unloadPage 只有路由事件（reLaunch/redirectTo/
 * navigateBack/switchTab）会触发，退出小程序走的是 onAppEnterBackground，只派发
 * App.onHide，页面不收 onUnload。
 */
export enum DMPPageStateTeardown {
  /** 路由重建页面栈：旧页面确实被路由卸载。 */
  Routing,
  /** 退出小程序或整体换运行时：运行时随后整体销毁，页面不派发 onUnload。 */
  Exit,
}

/** 该原因下页面栈是否应当收到 Page.onUnload。 */
export function dispatchesPageUnload(reason: DMPPageStateTeardown): boolean {
  return reason === DMPPageStateTeardown.Routing
}
