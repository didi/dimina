package com.didi.dimina.ui.container

/**
 * 决定一次 pageShow 是立刻送出，还是押到这一页的窗口几何写进 service 之后。
 *
 * 押后的前提是调用方**能证明窗口接下来一定会变**（判据见 `PageOrientation.defersPageShow`）。
 * 证明不了却押后，就等于把 pageShow 永久扣住：没有任何几何事件会来放行，页面的 onShow 再也不触发，service 侧还会一直把这一页当作隐藏的、连带丢掉后续的 resize。
 * 所以 [arm] 的 `defer` 为 false 时直接把目标交回给调用方送出。
 *
 * 押后的页面只有一个槽位，[arm] 覆写它、[cancel] 清空它，[release] 只认槽里存的那一个对象本身。
 * 切 tab、再次跳转或 onPause 之后才到达的几何回调因此放行不了已经被替换掉的页面：那一刻槽里要么是新页面，要么是空的。
 *
 * 状态只此一份，调用方不要另存 pending。
 */
internal class PageShowGate<T : Any> {

    private var pending: T? = null

    /**
     * 登记 [target] 这一页要发 pageShow。
     *
     * @param defer 容器能否证明窗口接下来一定会转。证明不了就必须立刻送出。
     * @return 需要**立刻**发 pageShow 的目标；null 表示已经押后，等 [release]。
     */
    fun arm(target: T, defer: Boolean): T? {
        pending = null
        if (!defer) {
            return target
        }
        pending = target
        return null
    }

    /**
     * 几何已经结算：如果押着的正是 [activeTarget] 这一页，把它交出来。
     *
     * @return 需要发 pageShow 的目标；null 表示没有押着的、或押着的是别的页面。
     */
    fun release(activeTarget: T?): T? {
        val armed = pending ?: return null
        if (armed !== activeTarget) {
            return null
        }
        pending = null
        return armed
    }

    /** 页面不再可见：作废押着的那一次，迟到的几何回调不能再放行它。 */
    fun cancel() {
        pending = null
    }
}
