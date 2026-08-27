/**
 * App 级可见性账本。
 *
 * 微信里 App.onShow / App.onHide 严格交替，同一个状态不会重复派发。跨小程序打开的目标
 * 从进入展示栈到 logic.js 跑起来之间还有一段窗口：这期间 DiminaServiceBridge 尚未注册，
 * 直接投递的 appHide 会整条丢在 Worker 里，小程序于是在后台以为自己仍在前台。
 *
 * 账本只记两件事——容器认定的可见状态，和最后真正送达 service 的状态。窗口期内只更新前者，
 * 运行时就绪时再补发差额。运行时被替换时送达状态回到「已显示」：新 Worker 自己会派发一次
 * App.onLaunch/onShow。
 *
 * 容器意图与运行时寿命是两条线：换掉 Worker 不改变容器是否可见，所以 restart 期间到达的
 * 系统前后台变化仍然记在 desired 上，由新运行时就绪时结算。只有真正「退出后重新展示」
 * 才把意图拨回可见，见 [markRuntimeRelaunched]。
 */
export class DMPAppVisibilityLedger {
  private desired: boolean = true
  private sent: boolean = true
  private ready: boolean = false

  /**
   * logic.js 已就绪，可以收生命周期消息了。返回 true 表示窗口期里欠了一次 appHide，
   * 调用方现在补发——运行时未就绪时送达状态恒为「已显示」，欠账只可能是这一个方向。
   */
  markServiceReady(): boolean {
    this.ready = true
    if (this.sent === this.desired) {
      return false
    }
    this.sent = this.desired
    return true
  }

  /**
   * 运行时即将销毁：把终态 appHide 交给旧 Worker。返回 true 表示调用方现在派发。
   *
   * 这不是一次容器隐藏，所以只推进送达状态、不动容器意图。派发后旧 Worker 不再是有效
   * 投递目标（ready 归假），销毁窗口期内到达的前后台变化只记账，等新运行时结算。
   */
  requestRuntimeTeardownHide(): boolean {
    if (!this.ready) {
      return false
    }
    this.ready = false
    if (!this.sent) {
      return false
    }
    this.sent = false
    return true
  }

  /** 运行时被销毁或替换：新 Worker 起来之前不能再投递，容器意图保持不变。 */
  markRuntimeReplaced(): void {
    this.ready = false
    this.sent = true
  }

  /**
   * 退出之后重新启动：容器随之重新展示，意图一并回到「已显示」。与 [markRuntimeReplaced]
   * 的区别在于容器本身也变了——退出时记下的隐藏状态到这里已经过期。
   */
  markRuntimeRelaunched(): void {
    this.markRuntimeReplaced()
    this.desired = true
  }

  /**
   * 请求把可见状态切到 [visible]。返回 true 表示调用方现在就该派发对应事件；
   * 返回 false 表示状态没变，或运行时还没就绪、要等 markServiceReady 补发。
   */
  request(visible: boolean): boolean {
    if (this.desired === visible) {
      return false
    }
    this.desired = visible
    if (!this.ready) {
      return false
    }
    this.sent = visible
    return true
  }
}
