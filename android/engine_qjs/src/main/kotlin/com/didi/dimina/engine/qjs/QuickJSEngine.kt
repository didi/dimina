package com.didi.dimina.engine.qjs

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * QuickJS JavaScript Engine wrapper for Kotlin
 * Provides JNI interfaces to interact with the QuickJS engine using a dedicated thread
 * Each instance is isolated and independent to support multiple mini-apps
 */
class QuickJSEngine {
    private val tag = "QuickJSEngine"

    /**
     * Unique instance ID for this engine
     */
    private val instanceId = nextInstanceId.getAndIncrement()

    /**
     * Dedicated thread for JavaScript execution
     */
    private var jsThread: Thread? = null

    /**
     * Queue for JavaScript tasks
     */
    private val taskQueue = LinkedBlockingQueue<JSTask<*>>()

    /**
     * Flag to indicate if the engine is running
     */
    private var isRunning = false

    /**
     * Handler for main thread callbacks
     */
    private val mainHandler = Handler(Looper.getMainLooper())

    // Note: Timer and interval management is now handled by libuv in native code
    // No need for Kotlin-side timer handlers anymore

    /**
     * Native pointer to the QuickJS runtime
     */
    private var nativeRuntimePtr: Long = 0

    /**
     * Native pointer to the QuickJS context
     */
    private var nativeContextPtr: Long = 0

    /**
     * Native pointer to the libuv event loop
     */
    private var nativeLoopPtr: Long = 0

    companion object {
        // Used to load the 'dimina' library on application startup.
        init {
            System.loadLibrary("dimina")
        }
        // Counter to generate unique instance IDs
        private val nextInstanceId = AtomicInteger(1)

        // Map to store all active engine instances by ID
        private val engineInstances = ConcurrentHashMap<Int, QuickJSEngine>()

        // Get an engine instance by ID
        @JvmStatic
        fun getInstanceById(id: Int): QuickJSEngine? {
            return engineInstances[id]
        }
    }

    /**
     * Task class for JavaScript operations
     */
    private abstract class JSTask<T> {
        val result = AtomicReference<T?>(null)
        val latch = CountDownLatch(1)
        var error: String? = null

        abstract fun execute(engine: QuickJSEngine)

        fun await(timeout: Long = 30, unit: TimeUnit = TimeUnit.SECONDS): T? {
            latch.await(timeout, unit)
            return result.get()
        }

        fun complete(value: T?) {
            result.set(value)
            latch.countDown()
        }

        fun completeWithError(errorMessage: String) {
            error = errorMessage
            latch.countDown()
        }
    }

    /**
     * Initialize and create a new QuickJS runtime and context
     * @return true if initialization was successful, false otherwise
     */
    fun initialize(): Boolean {
        if (isRunning) {
            Log.d(tag, "QuickJS engine already initialized (instance ID: $instanceId)")
            return false
        }

        // Register this instance in the global map
        engineInstances[instanceId] = this

        // Create and start the JavaScript thread
        jsThread = Thread({
            Log.d(tag, "Starting JavaScript thread with libuv event loop for instance ID: $instanceId")

            // Initialize the QuickJS engine on this thread
            val initResult = nativeInitialize(instanceId)
            if (!initResult) {
                Log.e(tag, "Failed to initialize QuickJS engine on JS thread (instance ID: $instanceId)")
                engineInstances.remove(instanceId)
                return@Thread
            }

            isRunning = true
            Log.d(tag, "QuickJS engine with libuv initialized on dedicated thread (instance ID: $instanceId)")

            // Process tasks and run event loop
            while (isRunning) {
                try {
                    // Process JavaScript tasks from the queue
                    val task = taskQueue.poll(10, TimeUnit.MILLISECONDS)
                    if (task != null) {
                        try {
                            task.execute(this)
                        } catch (e: Exception) {
                            Log.e(tag, "Error executing JS task (instance ID: $instanceId)", e)
                            task.completeWithError("Error: ${e.message}")
                        }
                    }

                    // Run the libuv event loop to process timers and I/O
                    // This is non-blocking and will return immediately if no events
                    nativeRunEventLoop(instanceId)

                } catch (e: InterruptedException) {
                    Log.d(tag, "JavaScript thread interrupted (instance ID: $instanceId)")
                    break
                } catch (e: Exception) {
                    Log.e(tag, "Error in event loop (instance ID: $instanceId)", e)
                }
            }

            // Clean up when the thread is stopping
            nativeStopEventLoop(instanceId)
            nativeDestroy(instanceId)
            nativeRuntimePtr = 0
            nativeContextPtr = 0
            nativeLoopPtr = 0
            engineInstances.remove(instanceId)
            Log.d(tag, "JavaScript thread stopped (instance ID: $instanceId)")
        }, "JSThread-$instanceId")

        jsThread?.start()

        // Wait for initialization to complete
        Thread.sleep(100) // Give the thread time to initialize
        return isRunning
    }

    /**
     * Evaluate JavaScript code and return the result
     * @param script The JavaScript code to evaluate
     * @return The result of the evaluation
     */
    fun evaluate(script: String): JSValue {
        if (!isRunning) {
            return JSValue.createError("Engine not initialized")
        }

        val task = object : JSTask<JSValue>() {
            override fun execute(engine: QuickJSEngine) {
                try {
                    val result = engine.nativeEvaluate(script)
                    complete(result)
                } catch (e: Exception) {
                    Log.e(tag, "Error evaluating script", e)
                    complete(JSValue.createError("Error: ${e.message}"))
                }
            }
        }

        taskQueue.offer(task)
        return task.await() ?: JSValue.createError("Evaluation timed out")
    }

    /**
     * Evaluate JavaScript code from a file path and return the result
     * @param filePath The path to the JavaScript file to evaluate
     * @return The result of the evaluation
     */
    fun evaluateFromFile(filePath: String): JSValue {
        if (!isRunning) {
            return JSValue.createError("Engine not initialized")
        }

        val task = object : JSTask<JSValue>() {
            override fun execute(engine: QuickJSEngine) {
                try {
                    Log.d(tag, "Evaluating script from file: $filePath")
                    val result = engine.nativeEvaluateFromFile(filePath)
                    complete(result)
                } catch (e: Exception) {
                    Log.e(tag, "Error evaluating script from file", e)
                    complete(JSValue.createError("Error: ${e.message}"))
                }
            }
        }

        taskQueue.offer(task)
        return task.await() ?: JSValue.createError("Evaluation timed out")
    }

    /**
     * Evaluate JavaScript code asynchronously and return the result via callback
     * @param script The JavaScript code to evaluate
     * @param callback The callback to receive the result
     */
    fun evaluateAsync(script: String, callback: (JSValue) -> Unit) {
        if (!isRunning) {
            mainHandler.post { callback(JSValue.createError("Engine not initialized")) }
            return
        }

        val task = object : JSTask<JSValue>() {
            override fun execute(engine: QuickJSEngine) {
                try {
                    Log.d(tag, "Evaluating script asynchronously: ${script.take(50)}${if (script.length > 50) "..." else ""}")
                    val result = engine.nativeEvaluate(script)
                    Log.d(tag, "Async evaluation result type: ${result.type}")
                    complete(result)
                    mainHandler.post { callback(result) }
                } catch (e: Exception) {
                    Log.e(tag, "Error in async evaluation", e)
                    val errorResult = JSValue.createError("Error in async evaluation: ${e.message}")
                    complete(errorResult)
                    mainHandler.post { callback(errorResult) }
                }
            }
        }

        taskQueue.offer(task)
    }

    /**
     * Evaluate JavaScript code from a file path asynchronously and return the result via callback
     * @param filePath The path to the JavaScript file to evaluate
     * @param callback The callback to receive the result
     */
    fun evaluateFromFileAsync(filePath: String, callback: (JSValue) -> Unit) {
        if (!isRunning) {
            mainHandler.post { callback(JSValue.createError("Engine not initialized")) }
            return
        }

        val task = object : JSTask<JSValue>() {
            override fun execute(engine: QuickJSEngine) {
                try {
                    Log.d(tag, "Evaluating script from file asynchronously: $filePath")
                    val result = engine.nativeEvaluateFromFile(filePath)
                    Log.d(tag, "Async file evaluation result type: ${result.type}")
                    complete(result)
                    mainHandler.post { callback(result) }
                } catch (e: Exception) {
                    Log.e(tag, "Error in async file evaluation", e)
                    val errorResult = JSValue.createError("Error in async file evaluation: ${e.message}")
                    complete(errorResult)
                    mainHandler.post { callback(errorResult) }
                }
            }
        }

        taskQueue.offer(task)
    }

    /**
     * Release the QuickJS runtime and context
     */
    fun destroy() {
        Log.d(tag, "Destroying QuickJS engine (instance ID: $instanceId)")

        // Signal the thread to stop
        isRunning = false

        // Clear the task queue
        taskQueue.clear()

        // Wait for the thread to finish
        jsThread?.join(1000)

        // If the thread is still alive, interrupt it
        if (jsThread?.isAlive == true) {
            jsThread?.interrupt()
        }

        jsThread = null

        // Remove from instances map
        engineInstances.remove(instanceId)

        // Suggest garbage collection to clean up any lingering objects
        System.gc()
        Log.d(tag, "QuickJS engine destroyed (instance ID: $instanceId)")
    }

    /**
     * Check if the engine is initialized
     * @return true if the engine is initialized, false otherwise
     */
    fun isInitialized(): Boolean {
        return isRunning && jsThread?.isAlive == true
    }

    /**
     * Native method declarations
     */
    private external fun nativeInitialize(instanceId: Int): Boolean
    private external fun nativeEvaluate(script: String, instanceId: Int = this.instanceId): JSValue
    private external fun nativeEvaluateFromFile(filePath: String, instanceId: Int = this.instanceId): JSValue
    private external fun nativeRunEventLoop(instanceId: Int = this.instanceId)
    private external fun nativeStopEventLoop(instanceId: Int = this.instanceId)
    private external fun nativeDestroy(instanceId: Int)

    /**
     * Callbacks for invoke and publish methods
     */
    private val invokeCallbacks = mutableMapOf<String, (JSONObject) -> JSValue?>()
    private val publishCallbacks = mutableMapOf<String, (JSONObject) -> Unit>()

    fun setInvokeCallback(id: String, callback: (JSONObject) -> JSValue?) {
        invokeCallbacks[id] = callback
    }

    fun removeInvokeCallback(id: String, callback: (JSONObject) -> JSValue?): Boolean {
        return invokeCallbacks.remove(id, callback)
    }

    fun clearInvokeCallbacks() {
        invokeCallbacks.clear()
    }

    fun setPublishCallback(id: String, callback: (JSONObject) -> Unit) {
        publishCallbacks[id] = callback
    }

    fun removePublishCallback(id: String, callback: (JSONObject) -> Unit): Boolean {
        return publishCallbacks.remove(id, callback)
    }

    fun clearPublishCallbacks() {
        publishCallbacks.clear()
    }

    @Suppress("unused")
    fun invokeFromJS(msg: JSONObject) : JSValue? {
        Log.d(tag, "从 JavaScript 接收调用 Received invoke from JavaScript: $msg")
        val body = msg.getJSONObject("body")
        val id = body.optString("bridgeId")
        return invokeCallbacks[id]?.invoke(msg)
    }

    @Suppress("unused")
    fun publishFromJS(id: String, msg: JSONObject) {
        Log.d(tag, "Received publish from JavaScript: id=$id, message=$msg")
        mainHandler.post {
            publishCallbacks[id]?.invoke(msg)
        }
    }

    // Note: Timer and interval scheduling is now handled entirely by libuv in native code
    // The scheduleTimer, clearTimer, scheduleInterval, and clearInterval methods are no longer needed
    // as setTimeout/setInterval in JavaScript directly use libuv timers

    /**
     * Get the instance ID for this engine
     */
    fun getInstanceId(): Int {
        return instanceId
    }
}

