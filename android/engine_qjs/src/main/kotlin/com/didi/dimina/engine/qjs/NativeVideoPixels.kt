package com.didi.dimina.engine.qjs

import java.nio.ByteBuffer

/** Pixel math stays native even when ART runs the host in debuggable mode. */
object NativeVideoPixels {
    init { System.loadLibrary("dimina") }

    // Each plane has position, limit, row stride and pixel stride in layout.
    // Input storage is borrowed only for this synchronous call; output is owned.
    external fun rgba(width: Int, height: Int, left: Int, top: Int,
        y: ByteBuffer, u: ByteBuffer, v: ByteBuffer, layout: IntArray,
        fullRange: Boolean, bt709: Boolean): ByteArray
}
