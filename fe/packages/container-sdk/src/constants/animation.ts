export const PRESENT_TRANSITION_MS = 540
export const LAUNCH_SCREEN_MIN_MS = PRESENT_TRANSITION_MS + 20
export const WAIT_TRANSITION_TIMEOUT_MS = LAUNCH_SCREEN_MIN_MS

/**
 * showModal 防点击穿透的延迟窗口（毫秒）：dialog 同步挂载但保持
 * pointer-events:none，此窗口后才加 .show 放开点击。100ms 足以覆盖
 * mobile WebKit 上 mouseup → click 最长 ~80ms 的间隔，也正卡在人眼能察觉延迟的
 * 阈值上——再大用户就会感到卡顿。
 */
export const MODAL_GUARD_MS = 100
