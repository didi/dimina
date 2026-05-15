export const PRESENT_TRANSITION_MS = 540
export const LAUNCH_SCREEN_MIN_MS = PRESENT_TRANSITION_MS + 20
export const WAIT_TRANSITION_TIMEOUT_MS = LAUNCH_SCREEN_MIN_MS

/**
 * showModal 防点击穿透的延迟窗口（毫秒）
 *
 * dialog 同步挂载到 DOM 但保持 `pointer-events: none`，
 * MODAL_GUARD_MS 之后才加 `.show`、`pointer-events: auto`，让 confirm/cancel 可点。
 *
 * 这个数字的选择：
 *   - 浏览器 click 事件 dispatch 本身 < 5ms
 *   - mobile WebKit 上 mouseup → click 间隔可达 30~80ms（fastclick/dblclick 检测）
 *   - 人眼"瞬时弹出"感知阈值约 100ms，超过这个值用户能察觉到延迟
 * 取 100ms 同时满足"足够覆盖事件链"和"用户感受不到延迟"。
 */
export const MODAL_GUARD_MS = 100
