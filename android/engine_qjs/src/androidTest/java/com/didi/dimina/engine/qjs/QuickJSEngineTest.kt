package com.didi.dimina.engine.qjs

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * Instrumented tests for QuickJSEngine with libuv event loop
 * 
 * These tests run on an Android device or emulator, so they have access
 * to the native library.
 * 
 * ## 测试覆盖范围
 * 
 * ### 功能覆盖
 * - setTimeout/setInterval 基本功能
 * - clearTimeout/clearInterval 功能
 * - 嵌套定时器、零延迟定时器
 * - 定时器执行顺序、Promise 与定时器交互
 * - 错误处理、大量并发定时器
 * 
 * ### 场景覆盖
 * - 单个/多个并发定时器、嵌套定时器
 * - 自我清除/外部清除的定时器
 * - 混合微任务和宏任务、错误恢复、压力测试
 * 
 * ### 边界条件
 * - 零延迟、快速创建/取消、大量定时器（50+）
 * - 回调中抛出异常、精度测试
 * 
 * ## 性能基准
 * 
 * | 指标 | 预期值 | 说明 |
 * |------|--------|------|
 * | 定时器精度 | ±50ms | 在 100ms 定时器测试中 |
 * | 并发定时器数 | 50+ | 无明显性能下降 |
 * | 创建定时器开销 | < 5ms | 50 个定时器批量创建 |
 * | 取消定时器响应 | 立即 | clearTimeout/clearInterval |
 * 
 * ## 已知限制
 * 
 * 1. **定时器精度**: 在高负载情况下可能有轻微延迟
 * 2. **最大定时器数**: 理论上无限制，实际受内存限制
 * 3. **最小延迟**: 虽然支持 0 延迟，但实际会有小的系统开销
 * 
 * ## 故障排查
 * 
 * - **超时失败**: 检查 Thread.sleep() 时间是否足够，确认设备性能足够
 * - **顺序错误**: 可能是系统负载导致的时间偏差，适当增加等待时间
 * - **计数不匹配**: 检查定时器是否被正确清除，验证事件循环是否正常运行
 * 
 * ## JavaScript 测试示例
 * 
 * 可以在 JavaScript 代码中直接测试定时器功能：
 * 
 * ### 基本 setTimeout 测试
 * ```javascript
 * console.log("开始测试 setTimeout");
 * setTimeout(() => {
 *     console.log("1秒后执行");
 * }, 1000);
 * console.log("已设置 setTimeout");
 * ```
 * 
 * ### setInterval 测试
 * ```javascript
 * let count = 0;
 * const id = setInterval(() => {
 *     count++;
 *     console.log("执行次数: " + count);
 *     if (count >= 5) {
 *         clearInterval(id);
 *         console.log("已清除 interval");
 *     }
 * }, 500);
 * ```
 * 
 * ### 嵌套定时器测试
 * ```javascript
 * setTimeout(() => {
 *     console.log("第一层: 500ms");
 *     setTimeout(() => {
 *         console.log("第二层: 1000ms");
 *         setTimeout(() => {
 *             console.log("第三层: 1500ms");
 *         }, 500);
 *     }, 500);
 * }, 500);
 * ```
 * 
 * ### Promise + setTimeout 混合测试
 * ```javascript
 * Promise.resolve("Promise 值").then(value => {
 *     console.log("Promise resolved: " + value);
 * });
 * 
 * setTimeout(() => {
 *     console.log("setTimeout 执行");
 * }, 100);
 * ```
 * 
 * ### 性能基准测试
 * ```javascript
 * // 创建大量定时器的性能
 * const start = Date.now();
 * for (let i = 0; i < 1000; i++) {
 *     setTimeout(() => {}, 1000);
 * }
 * console.log("创建时间: " + (Date.now() - start) + "ms");
 * 
 * // 定时器执行精度
 * const expectedTime = Date.now() + 1000;
 * setTimeout(() => {
 *     const diff = Date.now() - expectedTime;
 *     console.log("时间差: " + diff + "ms");
 * }, 1000);
 * ```
 * 
 */
@RunWith(AndroidJUnit4::class)
class QuickJSEngineTest {

    @Test
    fun largeBinaryFileMessagesBypassJsonAndPreserveCallbackOrder() {
        assertTrue(jsEngine.initialize())
        val expected = ByteArray(8 * 1024 * 1024) { 173.toByte() }.apply {
            this[0] = 0; this[lastIndex] = 255.toByte()
        }
        jsEngine.setInvokeCallback("file") { message ->
            val params = message.getJSONObject("body").getJSONObject("params")
            assertArrayEquals(expected, params.get("data") as ByteArray)
            JSValue.createNative(JSONObject().put("data", expected).put("empty", ByteArray(0)))
        }
        val result = jsEngine.evaluate("""
            JSON.stringify = function() { throw new Error('binary bridge must not stringify'); };
            var payload = new Uint8Array(8 * 1024 * 1024);
            payload.fill(173); payload[0] = 0; payload[payload.length - 1] = 255;
            var result = DiminaServiceBridge.invoke({type:'invokeAPI', target:'container', body:{
                bridgeId:'file', name:'FileSystemManager.writeFileSync', params:{data:payload.buffer}
            }});
            result.data instanceof ArrayBuffer && result.data.byteLength === payload.length &&
                new Uint8Array(result.data)[0] === 0 && new Uint8Array(result.data)[payload.length-1] === 255 &&
                result.empty instanceof ArrayBuffer && result.empty.byteLength === 0;
        """.trimIndent())
        assertEquals(result.toString(), JSValue.Type.BOOLEAN, result.type)
        assertTrue(result.booleanValue)
        jsEngine.evaluate("""
            var events=[];
            DiminaServiceBridge.onMessage=function(message) {
                var bytes=new Uint8Array(message.body.args.data);
                events.push(message.body.id + ':' + bytes.length + ':' + bytes[bytes.length-1]);
            };
        """.trimIndent())
        for (id in listOf("success", "complete")) {
            val message = JSONObject().put("type", "triggerCallback").put("body",
                JSONObject().put("id", id).put("args", JSONObject().put("data", expected)))
            assertEquals(JSValue.Type.UNDEFINED, jsEngine.sendMessage(message).type)
        }
        assertTrue(jsEngine.evaluate("events.join(',') === 'success:8388608:255,complete:8388608:255'").booleanValue)
    }
    
    private lateinit var jsEngine: QuickJSEngine
    
    @Before
    fun setUp() {
        // Create a new QuickJSEngine instance before each test
        jsEngine = QuickJSEngine()
    }
    
    @After
    fun tearDown() {
        // Clean up resources after each test
        if (::jsEngine.isInitialized) {
            // Even if the engine reports as not initialized, try to destroy it
            // to ensure all native resources are properly cleaned up
            jsEngine.destroy()
            
            // Add a small delay to allow GC to run
            Thread.sleep(100)
        }
    }
    
    @Test
    fun testSimpleJavaScriptExpression() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Execute simple JavaScript expression
        val simpleResult = jsEngine.evaluate("1 + 2 * 3")
        assertEquals(7, simpleResult.numberValue.toInt())
    }
    
    @Test
    fun testJavaScriptFunction() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Define and call a JavaScript function
        val functionScript = """
            function greet(name) {
                return 'Hello, ' + name + '!';
            }
            greet('Dimina');
        """.trimIndent()
        val functionResult = jsEngine.evaluate(functionScript)
        assertEquals("Hello, Dimina!", functionResult.stringValue)
    }
    
    @Test
    fun testJavaScriptObjects() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Work with JavaScript objects
        val objectScript = """
            const app = {
                name: 'Dimina',
                version: '1.0.0',
                getInfo: function() {
                    return this.name + ' v' + this.version;
                }
            };
            app.getInfo();
        """.trimIndent()
        val objectResult = jsEngine.evaluate(objectScript)
        assertEquals("Dimina v1.0.0", objectResult.stringValue)
    }
    
    @Test
    fun testTypedEvaluation() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Get typed result using evaluate
        // Wrap the object in parentheses to make it a valid expression
        val typedResult = jsEngine.evaluate("({ 'type': 'mini-program', 'active': true })")
        // Check that the result is correctly identified as an object
        assertEquals(JSValue.Type.OBJECT, typedResult.type)
        // Now we should get a proper JSON string representation of the object
        val resultStr = typedResult.toString()
        assertTrue("Result should contain 'type' property", resultStr.contains("type"))
        assertTrue("Result should contain 'mini-program' value", resultStr.contains("mini-program"))
        assertTrue("Result should contain 'active' property", resultStr.contains("active"))
        assertTrue("Result should contain 'true' value", resultStr.contains("true"))
    }
    
    @Test
    fun testEngineLifecycle() {
        // Test initialization
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        assertTrue("Engine should report as initialized", jsEngine.isInitialized())
        
        // Test destruction
        jsEngine.destroy()
        assertFalse("Engine should report as not initialized after destruction", jsEngine.isInitialized())
    }
    
    @Test
    fun testAsyncEvaluation() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Execute a simple JavaScript expression first to ensure the engine is working
        val simpleResult = jsEngine.evaluate("1 + 2")
        assertEquals(JSValue.Type.NUMBER, simpleResult.type)
        assertEquals("3.0", simpleResult.toString())
        
        // Execute a complex JavaScript computation asynchronously
        val script = """
            (() => {
                // Simple calculation for testing
                let result = 0;
                for (let i = 0; i < 100; i++) {
                    result += i;
                }
                return { sum: result, completed: true };
            })();
        """.trimIndent()
        
        // Use CountDownLatch to wait for async result
        val latch = CountDownLatch(1)
        val resultRef = AtomicReference<JSValue?>(null)

        // Use evaluateAsync to run the script in the dedicated JS thread
        jsEngine.evaluateAsync(script) { result ->
            // Print debug information
            println("AsyncResult type: ${result.type}")
            println("AsyncResult value: $result")
            
            resultRef.set(result)
            latch.countDown()
        }
        
        // Wait for the async result with a timeout
        assertTrue("Async evaluation timed out", latch.await(5, TimeUnit.SECONDS))

        // Get the result from the atomic reference
        val asyncResult = resultRef.get()!!
        
        // For now, let's modify the test to handle both OBJECT and ERROR types
        // This will help us understand if there's an intermittent issue
        if (asyncResult.type == JSValue.Type.OBJECT) {
            val resultStr = asyncResult.toString()
            assertTrue("Result should contain 'sum' property", resultStr.contains("sum"))
            assertTrue("Result should contain the correct sum value", resultStr.contains("4950")) // Sum of numbers 0-99
            assertTrue("Result should contain 'completed' property", resultStr.contains("completed"))
            assertTrue("Result should contain 'true' value", resultStr.contains("true"))
        } else {
            // Log the error but don't fail the test yet - we're debugging
            println("Error in async evaluation: $asyncResult")
            fail("Expected OBJECT type but got ${asyncResult.type}: $asyncResult")
        }
    }
    
    @Test
    fun testJavaScriptEventLoop() {
        // Initialize the engine
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        // Single script that runs once and captures the event loop behavior
        val setupScript = """
            // Create a global object to store our test state
            if (typeof globalThis.__eventLoopTest === 'undefined') {
                globalThis.__eventLoopTest = {
                    executionOrder: [],
                    originalLog: console.log,
                    allDone: false,
                    promisesDone: false,
                    setupComplete: false
                };
                
                // Override console.log to capture the output
                console.log = function(msg) {
                    globalThis.__eventLoopTest.executionOrder.push(msg);
                    globalThis.__eventLoopTest.originalLog(msg);
                };
            }
            
            // Function to check if everything is done
            function checkAllDone() {
                if (globalThis.__eventLoopTest.allDone) {
                    return globalThis.__eventLoopTest.executionOrder;
                }
                
                // If not done yet, return a special marker
                return ["NOT_DONE_YET"];
            }
            
            // Only run the test once
            if (!globalThis.__eventLoopTest.setupComplete) {
                globalThis.__eventLoopTest.setupComplete = true;
                
                console.log("script start");
                
                // Create a Promise to track when all microtasks are done
                Promise.resolve()
                    .then(() => {
                        console.log("Promise 1");
                        return Promise.resolve();
                    })
                    .then(() => {
                        console.log("Promise 2");
                        globalThis.__eventLoopTest.promisesDone = true;
                    });
                
                // Simple nextTick implementation using Promise
                Promise.resolve().then(() => {
                    console.log("nextTick 1");
                    return Promise.resolve().then(() => {
                        console.log("nextTick 2");
                    });
                });
                
                console.log("script end");
                
                // Use setTimeout with a callback that marks completion
                setTimeout(() => {
                    console.log("setTimeout");
                    // After setTimeout executes, all operations should be complete
                    globalThis.__eventLoopTest.allDone = true;
                }, 0);
            }
            
            // Return the current state - the test will retry if needed
            checkAllDone();
        """.trimIndent()
        
        // Use a retry mechanism to wait for setTimeout to complete
        val maxRetries = 10
        var retries = 0
        var finalResult: JSValue? = null
        
        while (retries < maxRetries) {
            // Execute the script
            val result = jsEngine.evaluate(setupScript)
            println("Attempt ${retries + 1}: $result")
            
            // Check if we got a valid result with all operations completed
            if (result.toString().contains("setTimeout")) {
                finalResult = result
                break
            }
            
            // Wait a bit before retrying
            Thread.sleep(500)
            retries++
        }
        
        // Make sure we got a result
        assertNotNull("Failed to get a complete result after $maxRetries retries", finalResult)
        
        // Convert the result to a string and verify the execution order
        val resultStr = finalResult.toString()
        println("Final execution order: $resultStr")
        
        // Expected execution order based on JavaScript event loop behavior:
        val expectedOrder = listOf(
            "script start",
            "script end",
            "Promise 1",
            "nextTick 1",
            "nextTick 2",
            "Promise 2",
            "setTimeout"
        )
        
        // Verify the presence of all expected log messages
        for (message in expectedOrder) {
            assertTrue("Result should contain '$message'", resultStr.contains(message))
        }
        
        // Verify the correct order by checking relative positions in the string
        for (i in 0 until expectedOrder.size - 1) {
            val currentMessage = expectedOrder[i]
            val nextMessage = expectedOrder[i + 1]
            assertTrue(
                "'$currentMessage' should appear before '$nextMessage'", 
                resultStr.indexOf(currentMessage) < resultStr.indexOf(nextMessage)
            )
        }
    }
    
    // ============================================
    // libuv Event Loop Tests
    // ============================================
    // 
    // 以下测试用例全面验证 libuv 事件循环的实现，包括：
    // 1. 基础功能测试 (4个): setTimeout, setInterval, clearTimeout, clearInterval
    // 2. 并发和顺序测试 (2个): 多个并发定时器, 嵌套定时器
    // 3. 事件循环优先级测试 (3个): 零延迟, Promise混合, 复杂场景
    // 4. 错误处理和健壮性测试 (3个): 错误隔离, 压力测试, 快速创建取消
    // 5. 特殊场景测试 (3个): 自我清除, 精度测试, 复杂混合
    
    /**
     * 测试 setTimeout 基本功能
     * 
     * 验证内容:
     * - 设置 100ms 延迟的定时器
     * - 验证在定时器执行前变量为 false
     * - 等待后验证变量变为 true
     * 
     * 预期结果: 定时器在指定时间后正确执行
     */
    @Test
    fun testBasicSetTimeout() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        val result = jsEngine.evaluate("""
            let executed = false;
            setTimeout(() => { executed = true; }, 100);
            executed;
        """)
        
        assertEquals(JSValue.Type.BOOLEAN, result.type)
        assertFalse(result.booleanValue)
        
        Thread.sleep(200) // 等待定时器执行
        
        val result2 = jsEngine.evaluate("executed")
        assertTrue("setTimeout callback should have executed", result2.booleanValue)
    }
    
    /**
     * 测试 setInterval 基本功能
     * 
     * 验证内容:
     * - 设置 50ms 间隔的定时器
     * - 在回调中计数
     * - 达到 3 次后自动清除
     * 
     * 预期结果: 定时器执行恰好 3 次
     */
    @Test
    fun testSetInterval() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            let count = 0;
            const id = setInterval(() => {
                count++;
                if (count >= 3) clearInterval(id);
            }, 50);
        """)
        
        Thread.sleep(250) // 等待 interval 执行多次
        
        val result = jsEngine.evaluate("count")
        assertEquals("setInterval should execute 3 times", 3, result.numberValue.toInt())
    }
    
    /**
     * 测试 clearTimeout 功能
     * 
     * 验证内容:
     * - 创建定时器后立即取消
     * - 验证回调未被执行
     * 
     * 预期结果: 被取消的定时器不执行
     */
    @Test
    fun testClearTimeout() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            let executed = false;
            const id = setTimeout(() => { executed = true; }, 100);
            clearTimeout(id);
        """)
        
        Thread.sleep(200)
        
        val result = jsEngine.evaluate("executed")
        assertFalse("Cleared timeout should not execute", result.booleanValue)
    }
    
    /**
     * 测试多个定时器按时间顺序执行
     * 
     * 验证内容:
     * - 同时创建 3 个不同延迟的定时器（50ms, 100ms, 75ms）
     * - 验证执行顺序为 A(50ms), C(75ms), B(100ms)
     * 
     * 预期结果: 定时器按延迟时间从短到长执行
     */
    @Test
    fun testMultipleConcurrentTimers() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            let results = [];
            setTimeout(() => results.push('A'), 50);
            setTimeout(() => results.push('B'), 100);
            setTimeout(() => results.push('C'), 75);
        """)
        
        Thread.sleep(150)
        
        val result = jsEngine.evaluate("JSON.stringify(results)")
        assertEquals("Timers should execute in order", "[\"A\",\"C\",\"B\"]", result.stringValue)
    }
    
    /**
     * 测试嵌套定时器功能
     * 
     * 验证内容:
     * - 在定时器回调中创建新的定时器
     * - 三层嵌套结构
     * 
     * 预期结果: 按嵌套顺序依次执行
     */
    @Test
    fun testNestedTimers() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.nestedResults = [];
            setTimeout(() => {
                nestedResults.push('first');
                setTimeout(() => {
                    nestedResults.push('second');
                    setTimeout(() => {
                        nestedResults.push('third');
                    }, 50);
                }, 50);
            }, 50);
        """)
        
        Thread.sleep(200) // 等待所有嵌套定时器完成
        
        val result = jsEngine.evaluate("JSON.stringify(nestedResults)")
        assertEquals("Nested timers should execute in order", "[\"first\",\"second\",\"third\"]", result.stringValue)
    }
    
    /**
     * 测试零延迟定时器的执行时机
     * 
     * 验证内容:
     * - 混合同步代码和零延迟定时器
     * - 验证执行顺序
     * 
     * 预期结果: 同步代码先执行，零延迟定时器在所有同步代码后执行
     */
    @Test
    fun testZeroDelayTimeout() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.executionOrder = [];
            executionOrder.push('sync1');
            setTimeout(() => {
                executionOrder.push('timeout');
            }, 0);
            executionOrder.push('sync2');
        """)
        
        Thread.sleep(100) // 等待零延迟定时器执行
        
        val result = jsEngine.evaluate("JSON.stringify(executionOrder)")
        assertEquals("Zero-delay timeout should execute after sync code", "[\"sync1\",\"sync2\",\"timeout\"]", result.stringValue)
    }
    
    /**
     * 测试 Promise 和定时器的执行顺序
     * 
     * 验证内容:
     * - 混合 Promise 和 setTimeout
     * - 验证微任务优先于宏任务
     * 
     * 预期结果: 顺序为 sync1 -> sync2 -> promise -> timeout
     */
    @Test
    fun testPromiseWithTimeout() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.promiseTimeoutOrder = [];
            
            promiseTimeoutOrder.push('start');
            
            Promise.resolve().then(() => {
                promiseTimeoutOrder.push('promise');
            });
            
            setTimeout(() => {
                promiseTimeoutOrder.push('timeout');
            }, 50);
            
            promiseTimeoutOrder.push('end');
        """)
        
        Thread.sleep(100)
        
        val result = jsEngine.evaluate("JSON.stringify(promiseTimeoutOrder)")
        assertEquals(
            "Promise should resolve before timeout",
            "[\"start\",\"end\",\"promise\",\"timeout\"]",
            result.stringValue
        )
    }
    
    /**
     * 测试 clearInterval 功能
     * 
     * 验证内容:
     * - 创建 interval 定时器
     * - 在 125ms 后取消（应执行 2-3 次）
     * 
     * 预期结果: 定时器在清除前执行 2-3 次
     */
    @Test
    fun testClearInterval() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            let intervalCount = 0;
            const id = setInterval(() => {
                intervalCount++;
            }, 50);
            
            setTimeout(() => {
                clearInterval(id);
            }, 125); // 清除应该在2-3次执行后发生
        """)
        
        Thread.sleep(250)
        
        val result = jsEngine.evaluate("intervalCount")
        val count = result.numberValue.toInt()
        assertTrue("Interval should execute 2-3 times before being cleared", count in 2..3)
    }
    
    /**
     * 测试定时器中的错误不会影响其他定时器
     * 
     * 验证内容:
     * - 创建 3 个定时器，中间一个抛出错误
     * - 验证前后定时器都正常执行
     * 
     * 预期结果: 错误被捕获，不影响其他定时器
     */
    @Test
    fun testTimerErrorHandling() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.errorTestResults = [];
            
            setTimeout(() => {
                errorTestResults.push('timer1');
            }, 50);
            
            setTimeout(() => {
                errorTestResults.push('error');
                throw new Error("Test error in timer");
            }, 100);
            
            setTimeout(() => {
                errorTestResults.push('timer2');
            }, 150);
        """)
        
        Thread.sleep(250)
        
        val result = jsEngine.evaluate("JSON.stringify(errorTestResults)")
        val resultStr = result.stringValue
        // 验证错误不会阻止后续定时器执行
        assertTrue("First timer should execute", resultStr!!.contains("timer1"))
        assertTrue("Error timer should execute", resultStr.contains("error"))
        assertTrue("Timer after error should still execute", resultStr.contains("timer2"))
    }
    
    /**
     * 压力测试 - 大量定时器
     * 
     * 验证内容:
     * - 创建 50 个定时器
     * - 使用随机延迟（0-100ms）
     * 
     * 预期结果: 所有 50 个定时器都成功执行
     */
    @Test
    fun testManyTimers() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.manyTimersCount = 0;
            for (let i = 0; i < 50; i++) {
                setTimeout(() => {
                    manyTimersCount++;
                }, Math.random() * 100);
            }
        """)
        
        Thread.sleep(200)
        
        val result = jsEngine.evaluate("manyTimersCount")
        assertEquals("All 50 timers should execute", 50, result.numberValue.toInt())
    }
    
    /**
     * 测试在 interval 回调中自我清除
     * 
     * 验证内容:
     * - interval 在回调中检查计数
     * - 达到 5 次后自我清除
     * 
     * 预期结果: 恰好执行 5 次后停止
     */
    @Test
    fun testIntervalWithClearInCallback() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            let selfClearCount = 0;
            const selfClearId = setInterval(() => {
                selfClearCount++;
                if (selfClearCount >= 5) {
                    clearInterval(selfClearId);
                }
            }, 50);
        """)
        
        Thread.sleep(400)
        
        val result = jsEngine.evaluate("selfClearCount")
        assertEquals("Interval should self-clear after 5 executions", 5, result.numberValue.toInt())
    }
    
    /**
     * 测试定时器精度
     * 
     * 验证内容:
     * - 测量 100ms 定时器的实际延迟
     * - 允许 ±50ms 误差范围
     * 
     * 预期结果: 实际延迟在 80-150ms 之间
     */
    @Test
    fun testTimerPrecision() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.startTime = Date.now();
            globalThis.endTime = 0;
            setTimeout(() => {
                endTime = Date.now();
            }, 100);
        """)
        
        Thread.sleep(150)
        
        val result = jsEngine.evaluate("endTime - startTime")
        val elapsed = result.numberValue.toInt()
        // 允许一定的误差范围（±50ms）
        assertTrue(
            "Timer should execute close to 100ms (actual: ${elapsed}ms)",
            elapsed in 80..150
        )
    }
    
    /**
     * 测试复杂事件循环场景
     * 
     * 验证内容:
     * - 混合同步代码、Promise、setTimeout、嵌套 Promise 和 setTimeout
     * - 验证多个关键执行顺序点
     * 
     * 预期结果:
     * - 同步代码最先执行
     * - Promise 在定时器之前执行
     * - 嵌套结构正确处理
     */
    @Test
    fun testComplexEventLoopScenario() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.complexOrder = [];
            
            complexOrder.push('sync1');
            
            setTimeout(() => {
                complexOrder.push('timeout1');
                Promise.resolve().then(() => {
                    complexOrder.push('promise-in-timeout');
                });
            }, 50);
            
            Promise.resolve().then(() => {
                complexOrder.push('promise1');
                setTimeout(() => {
                    complexOrder.push('timeout-in-promise');
                }, 50);
            });
            
            setTimeout(() => {
                complexOrder.push('timeout2');
            }, 100);
            
            Promise.resolve().then(() => {
                complexOrder.push('promise2');
            });
            
            complexOrder.push('sync2');
        """)
        
        Thread.sleep(200)
        
        val result = jsEngine.evaluate("JSON.stringify(complexOrder)")
        val order = result.stringValue
        
        // 验证关键的执行顺序
        assertTrue("Sync code should run first", order!!.indexOf("sync1") < order.indexOf("sync2"))
        assertTrue("Sync code should run before promises", order.indexOf("sync2") < order.indexOf("promise1"))
        assertTrue("Promises should run before timeouts", order.indexOf("promise1") < order.indexOf("timeout1"))
        assertTrue("Nested promise should run with its timeout", order.indexOf("timeout1") < order.indexOf("promise-in-timeout"))
    }
    
    /**
     * 测试快速创建和取消定时器
     * 
     * 验证内容:
     * - 创建 20 个定时器
     * - 立即取消其中 10 个
     * 
     * 预期结果: 只有未被取消的 10 个定时器执行
     */
    @Test
    fun testRapidTimerCreationAndCancellation() {
        val initialized = jsEngine.initialize()
        assertTrue("Engine should initialize successfully", initialized)
        
        jsEngine.evaluate("""
            globalThis.rapidCount = 0;
            const ids = [];
            
            // 创建 20 个定时器
            for (let i = 0; i < 20; i++) {
                const id = setTimeout(() => {
                    rapidCount++;
                }, 100);
                ids.push(id);
            }
            
            // 取消一半的定时器
            for (let i = 0; i < 10; i++) {
                clearTimeout(ids[i]);
            }
        """)
        
        Thread.sleep(200)
        
        val result = jsEngine.evaluate("rapidCount")
        assertEquals("Only 10 timers should execute", 10, result.numberValue.toInt())
    }
}
