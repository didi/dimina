package com.didi.dimina.ui.container

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Strings stand in for Activity instances: the tracker only ever compares them by identity/equality
 * and never touches the Android framework, so the whole lifecycle sequence can be driven on the JVM.
 */
class MiniProgramVisibilityTrackerTest {

    @Test
    fun `an activity that is only paused keeps the mini program in the foreground`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("app", "page")

        // A permission dialog, a system share sheet or a dialog-style picker pauses the hosting
        // activity without stopping it, so nothing at all is reported to the tracker. The mini
        // program is still on screen and must stay in the foreground however long the user lingers.
        assertTrue(tracker.isForeground("app"))

        // The contrast that gives the assertion above its meaning: a real stop *does* flip it.
        assertTrue(tracker.onActivityHidden("app", "page"))
        assertFalse(tracker.isForeground("app"))
    }

    @Test
    fun `moving between pages of the same mini program is never a background transition`() {
        val tracker = MiniProgramVisibilityTracker<String>()

        // Android starts the incoming page before it stops the outgoing one, so the two are briefly
        // visible together; neither step may be reported as a foreground/background change.
        assertTrue(tracker.onActivityVisible("app", "page-1"))
        assertFalse(tracker.onActivityVisible("app", "page-2"))
        assertFalse(tracker.onActivityHidden("app", "page-1"))

        assertTrue(tracker.isForeground("app"))
    }

    @Test
    fun `the mini program enters the background exactly once, when its last visible activity stops`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("app", "page-1")
        tracker.onActivityVisible("app", "page-2")

        assertFalse("one of two visible pages stopping is not a background transition", tracker.onActivityHidden("app", "page-1"))
        assertTrue("the last visible page stopping is the background transition", tracker.onActivityHidden("app", "page-2"))
        assertFalse(tracker.isForeground("app"))

        // A repeated stop for an already-gone page must not report a second transition.
        assertFalse(tracker.onActivityHidden("app", "page-2"))
    }

    @Test
    fun `returning to the foreground is reported once, for the first activity that becomes visible`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("app", "page-1")
        tracker.onActivityHidden("app", "page-1")

        assertTrue(tracker.onActivityVisible("app", "page-1"))
        assertFalse(tracker.onActivityVisible("app", "page-2"))
        assertTrue(tracker.isForeground("app"))
    }

    @Test
    fun `visibility is accounted per appId`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("app-a", "a-page")
        tracker.onActivityVisible("app-b", "b-page")

        assertTrue("app-a's last page stopping is app-a's transition", tracker.onActivityHidden("app-a", "a-page"))

        assertFalse(tracker.isForeground("app-a"))
        assertTrue("app-b must be untouched by app-a going to the background", tracker.isForeground("app-b"))
    }

    @Test
    fun `registering the same activity twice does not double count it`() {
        val tracker = MiniProgramVisibilityTracker<String>()

        assertTrue(tracker.onActivityVisible("app", "page"))
        assertFalse("a repeated start of the same instance is not a foreground transition", tracker.onActivityVisible("app", "page"))

        // Had the duplicate been counted, one stop would leave the mini program wrongly foreground.
        assertTrue(tracker.onActivityHidden("app", "page"))
        assertFalse(tracker.isForeground("app"))
    }

    @Test
    fun `stopping an activity that was never registered changes nothing`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("app", "page")

        assertFalse(tracker.onActivityHidden("app", "never-started"))
        assertTrue("an unknown instance must not evict the page that really is visible", tracker.isForeground("app"))

        assertTrue(tracker.onActivityHidden("app", "page"))
    }

    @Test
    fun `an appId that was never seen is in the background`() {
        val tracker = MiniProgramVisibilityTracker<String>()

        assertFalse(tracker.isForeground("never-opened"))
        assertFalse(tracker.onActivityHidden("never-opened", "page"))
        assertFalse("querying an unknown appId must not register it", tracker.isForeground("never-opened"))
    }

    @Test
    fun `an explicit cross mini program transition hides the whole source app exactly once`() {
        val tracker = MiniProgramVisibilityTracker<String>()
        tracker.onActivityVisible("source", "page-1")
        tracker.onActivityVisible("source", "page-2")

        assertTrue(tracker.onMiniProgramHidden("source"))
        assertFalse(tracker.isForeground("source"))
        assertFalse(tracker.onActivityHidden("source", "page-1"))
        assertFalse(tracker.onActivityHidden("source", "page-2"))
        assertFalse(tracker.onMiniProgramHidden("source"))
    }
}
