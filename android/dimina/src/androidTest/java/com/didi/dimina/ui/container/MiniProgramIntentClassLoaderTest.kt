package com.didi.dimina.ui.container

import android.content.Intent
import android.os.Parcel
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.didi.dimina.bean.MiniProgram
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Issue #361: system task Intents can carry extras with only the boot ClassLoader. */
@RunWith(AndroidJUnit4::class)
class MiniProgramIntentClassLoaderTest {
    private val program = MiniProgram(
        appId = "remote-app-a", name = "Remote A", path = "pages/index?id=1",
        updateManifestUrl = "https://example.com/a/manifest.json",
    )
    private val hostSession: String
        get() = companionField("hostSession") as String
    private val hostGeneration: Long
        get() = companionField("hostGeneration") as Long

    private fun companionField(name: String): Any =
        DiminaActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(null)!!

    private fun invoke(name: String, intent: Intent): Any? =
        DiminaActivity.Companion::class.java.getDeclaredMethod(name, Intent::class.java)
            .apply { isAccessible = true }.invoke(DiminaActivity.Companion, intent)

    private fun isObsolete(intent: Intent) = invoke("isObsoleteHostLaunch", intent) as Boolean
    private fun readProgram(intent: Intent) = invoke("getMiniProgramFromIntent", intent) as MiniProgram?

    private fun restoredIntent(
        value: MiniProgram = program,
        session: String? = hostSession,
        generation: Long = hostGeneration,
        withIdentity: Boolean = true,
    ): Intent {
        val original = Intent().apply {
            putExtra(DiminaActivity.MINI_PROGRAM_KEY, value)
            if (session != null) {
                putExtra("dimina_host_session", session)
                putExtra("dimina_host_generation", generation)
                if (withIdentity) MiniProgramTaskIdentity.attach(this, value.appId, session, generation)
            }
        }
        val parcel = Parcel.obtain()
        return try {
            original.writeToParcel(parcel, 0)
            parcel.setDataPosition(0)
            Intent.CREATOR.createFromParcel(parcel).apply { setExtrasClassLoader(null) }
        } finally {
            parcel.recycle()
        }
    }

    @Suppress("DEPRECATION")
    private fun payload(intent: Intent): MiniProgram? = intent.getParcelableExtra(DiminaActivity.MINI_PROGRAM_KEY)

    @Test fun sessionCheckPreparesParcelableBeforeReadingAnyExtras() {
        val restored = restoredIntent()
        assertFalse(isObsolete(restored))
        assertEquals(program, payload(restored))
    }

    @Test fun parcelableCanBeReadBeforeSessionCheck() {
        assertEquals(program, readProgram(restoredIntent()))
    }

    @Test fun destroyedGenerationIsStillRejected() {
        val restored = restoredIntent(generation = hostGeneration - 1)
        assertTrue(isObsolete(restored))
        assertEquals(program, payload(restored))
    }

    @Test fun previousProcessAndLegacyTaskExtrasRemainRestorable() {
        for (session in listOf("previous-process", null)) {
            val restored = restoredIntent(session = session, generation = hostGeneration - 1)
            assertFalse(isObsolete(restored))
            assertEquals(program, payload(restored))
        }
    }

    @Test fun scanningAnotherAppDoesNotFailOrMatchTheWrongTask() {
        val other = program.copy(appId = "remote-app-b", name = "Remote B")
        // The first Intent models a legacy task without a URI; the second has current metadata.
        val tasks = listOf(restoredIntent(withIdentity = false), restoredIntent(value = other))
        fun find(appId: String) = MiniProgramTaskLookup.find(
            tasks, null, appId, taskId = { tasks.indexOf(it) },
            rootAppId = { intent ->
                if (isObsolete(intent)) null else {
                    MiniProgramTaskIdentity.appId(intent, hostSession, hostGeneration)
                        ?: readProgram(intent)?.appId
                }
            },
        )
        assertSame(tasks[1], find(other.appId))
        assertSame(tasks[0], find(program.appId))
        assertNull(find("remote-app-c"))
    }

    @Test fun strippedTaskExtrasDoNotRequireAParcelable() {
        val stripped = restoredIntent().cloneFilter()
        assertFalse(isObsolete(stripped))
        assertNull(readProgram(stripped))
        assertEquals(program.appId, MiniProgramTaskIdentity.appId(stripped, hostSession, hostGeneration))
    }
}
