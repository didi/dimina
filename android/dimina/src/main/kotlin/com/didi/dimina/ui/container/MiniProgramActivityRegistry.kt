package com.didi.dimina.ui.container

/**
 * 追踪构成小程序页面栈的 Android Activity 实例。
 *
 * 所有页面复用同一个 Activity 类，系统按组件类型做的 CLEAR_TOP 查找
 * 无法区分根页面和当前页面。
 */
internal class MiniProgramActivityRegistry<T> {
    private val activitiesByAppId = mutableMapOf<String, LinkedHashSet<T>>()

    @Synchronized
    fun register(appId: String, activity: T) {
        activitiesByAppId.getOrPut(appId) { linkedSetOf() }.add(activity)
    }

    @Synchronized
    fun unregister(appId: String, activity: T) {
        val activities = activitiesByAppId[appId] ?: return
        activities.remove(activity)
        if (activities.isEmpty()) {
            activitiesByAppId.remove(appId)
        }
    }

    @Synchronized
    fun lastRegistered(appId: String): T? = activitiesByAppId[appId]?.lastOrNull()

    @Synchronized
    fun lastMatching(appId: String, matches: (T) -> Boolean): T? =
        activitiesByAppId[appId]?.lastOrNull(matches)

    @Synchronized
    fun snapshot(appId: String): List<T> = activitiesByAppId[appId]?.toList().orEmpty()

    /**
     * Atomically removes up to [delta] pages from the top while retaining the first page.
     * Remove entries before finishing Activities so a second call cannot pop a pending destroy.
     */
    fun navigateBack(appId: String, delta: Int, close: (T) -> Unit): Boolean {
        val toClose = synchronized(this) {
            val activities = activitiesByAppId[appId] ?: return false
            val count = delta.coerceAtLeast(1).coerceAtMost(activities.size - 1)
            if (count <= 0) return false
            activities.toList().takeLast(count).also { pages ->
                activities.removeAll(pages.toSet())
            }
        }
        toClose.asReversed().forEach(close)
        return true
    }

    fun closeEveryApp(close: (T) -> Unit) {
        val activities = synchronized(this) {
            val snapshot = activitiesByAppId.values.flatMap { it.toList() }
            activitiesByAppId.clear()
            snapshot
        }
        activities.asReversed().forEach(close)
    }

    fun closeAll(appId: String, close: (T) -> Unit) {
        val activities = synchronized(this) {
            activitiesByAppId.remove(appId)?.toList().orEmpty()
        }
        activities.asReversed().forEach(close)
    }

    /**
     * 关闭 [appId] 下除 [keep] 匹配到的那个之外的所有 Activity（多个匹配时取注册
     * 顺序里第一个）。保留的 Activity 继续留在账本里，其余按 [closeAll] 同样的
     * 从上到根顺序关闭。返回被保留的 Activity；没有匹配到时等价于 [closeAll]，
     * 返回 null。
     *
     * 读取账本快照和决定保留谁，与 register/unregister 共用同一把锁做原子操作，
     * 避免读到并发生命周期变化的中间状态。
     */
    fun closeAllExcept(appId: String, keep: (T) -> Boolean, close: (T) -> Unit): T? {
        val (kept, toClose) = synchronized(this) {
            val activities = activitiesByAppId[appId]?.toList().orEmpty()
            val keptActivity = activities.firstOrNull(keep)
            if (keptActivity != null) {
                activitiesByAppId[appId] = linkedSetOf(keptActivity)
            } else {
                activitiesByAppId.remove(appId)
            }
            keptActivity to activities.filter { it !== keptActivity }
        }
        toClose.asReversed().forEach(close)
        return kept
    }
}
