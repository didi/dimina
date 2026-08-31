package com.didi.dimina.ui.container

import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class PageShowGateTest {

    private class Page(private val name: String) {
        override fun toString(): String = name
    }

    @Test
    fun `a page nobody can prove the window will move for is handed back immediately`() {
        // 证明不了窗口会转，就没有任何几何事件会来放行。
        // 押后等于永久扣住 pageShow：页面的 onShow 再也不触发，service 侧还会一直把这一页当作隐藏的，连带丢掉 resize。
        val gate = PageShowGate<Page>()
        val page = Page("home")

        assertSame(page, gate.arm(page, defer = false))
    }

    @Test
    fun `a page handed back immediately leaves nothing pending for a later release`() {
        val gate = PageShowGate<Page>()
        val page = Page("home")

        gate.arm(page, defer = false)

        assertNull(
            "arm() already handed this page out; releasing on a later geometry event would send a second pageShow",
            gate.release(page),
        )
    }

    @Test
    fun `a deferred page waits for its settled geometry`() {
        val gate = PageShowGate<Page>()
        val page = Page("landscape")

        assertNull("the page must not be shown before its geometry reaches service", gate.arm(page, defer = true))
        assertSame(page, gate.release(page))
    }

    @Test
    fun `a released pageShow is not handed out twice`() {
        val gate = PageShowGate<Page>()
        val page = Page("landscape")

        gate.arm(page, defer = true)
        gate.release(page)

        assertNull(gate.release(page))
    }

    @Test
    fun `a geometry event for another page never releases the armed one`() {
        val gate = PageShowGate<Page>()
        val armed = Page("armed")
        val other = Page("other")

        gate.arm(armed, defer = true)

        assertNull(gate.release(other))
        assertSame("the armed page is still waiting for its own geometry", armed, gate.release(armed))
    }

    @Test
    fun `re-arming invalidates the previous page so a late geometry event cannot show it`() {
        // 切 tab / 再次跳转：前一页的几何回调可能在换页之后才到。
        val gate = PageShowGate<Page>()
        val first = Page("first")
        val second = Page("second")

        gate.arm(first, defer = true)
        gate.arm(second, defer = true)

        assertNull("the replaced page must never be shown", gate.release(first))
        assertSame(second, gate.release(second))
    }

    @Test
    fun `arming a page that needs no deferral drops a page still waiting behind it`() {
        // 押着一页横屏页时切到一页竖屏页：旧的那次必须作废，否则它会被下一次几何事件放行。
        val gate = PageShowGate<Page>()
        val deferred = Page("landscape")
        val immediate = Page("portrait")

        gate.arm(deferred, defer = true)
        assertSame(immediate, gate.arm(immediate, defer = false))

        assertNull("the page that was waiting must never be shown after it was replaced", gate.release(deferred))
    }

    @Test
    fun `cancel invalidates the armed page so a late geometry event cannot show it`() {
        // onPause 之后才到达的布局回调不能把一个已经不可见的页面显示出来。
        val gate = PageShowGate<Page>()
        val page = Page("paused")

        gate.arm(page, defer = true)
        gate.cancel()

        assertNull(gate.release(page))
    }

    @Test
    fun `releasing with no armed page is a no-op`() {
        val gate = PageShowGate<Page>()

        assertNull(gate.release(Page("whatever")))
        assertNull(gate.release(null))
    }

    @Test
    fun `an armed page is not released by a null active target`() {
        val gate = PageShowGate<Page>()
        val page = Page("armed")

        gate.arm(page, defer = true)

        assertNull("losing the active bridge must not be read as this page's geometry", gate.release(null))
    }
}
