package com.didi.dimina.ui.container

/**
 * 判定一个小程序整体是不是进入了后台。
 *
 * 判据是这个 appId 名下还有没有处于**可见**状态（onStart 之后、onStop 之前）的 Activity，
 * 而不是 onPause。权限弹窗、系统分享面板、以对话框或半屏形式出现的系统选择器都会让宿主
 * Activity 走 onPause 却仍然可见——这些场景里小程序并没有进入后台，按 onPause 判定会在
 * 用户停留超过后台宽限期时误杀掉全部 WebSocket 连接。
 *
 * 按 appId 分账而不是只做一个进程级前后台计数：同一个进程里从小程序 A 切到小程序 B 时，
 * A 确实进入了后台，进程级计数看不出这件事。
 *
 * 每个方法都返回「这次调用有没有真的改变前后台状态」，调用方据此只在真实迁移时通知下游，
 * 不必自己再存一份状态。
 */
internal class MiniProgramVisibilityTracker<T> {
    private val visibleActivities = mutableMapOf<String, LinkedHashSet<T>>()

    /**
     * 记录 [activity] 变为可见。返回 true 表示 [appId] 由此**从后台回到前台**，即这次调用
     * 之前它名下没有任何可见 Activity。重复登记同一个实例不构成迁移。
     */
    @Synchronized
    fun onActivityVisible(appId: String, activity: T): Boolean {
        val activities = visibleActivities.getOrPut(appId) { linkedSetOf() }
        val wasBackground = activities.isEmpty()
        activities.add(activity)
        return wasBackground
    }

    /**
     * 记录 [activity] 不再可见。返回 true 表示 [appId] 由此**进入后台**，即这次调用之后它
     * 名下再没有可见的 Activity。没登记过的实例不产生任何状态变化。
     */
    @Synchronized
    fun onActivityHidden(appId: String, activity: T): Boolean {
        val activities = visibleActivities[appId] ?: return false
        if (!activities.remove(activity)) return false
        if (activities.isNotEmpty()) return false
        visibleActivities.remove(appId)
        return true
    }

    /** [appId] 名下当前是否还有可见的 Activity。 */
    @Synchronized
    fun isForeground(appId: String): Boolean = !visibleActivities[appId].isNullOrEmpty()
}
