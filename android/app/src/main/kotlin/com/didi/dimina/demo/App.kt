package com.didi.dimina.demo

import android.app.Application
import com.didi.dimina.Dimina

class App: Application() {
    override fun onCreate() {
        super.onCreate()
        Dimina.init(this, Dimina.DiminaConfig.Builder()
            .setDebugMode(true)
            .setPageOrientationEnabled(true)
            .build()
        )
    }
}