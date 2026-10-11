#include "../quickjs_value.hpp"
#include <iostream>
#include <cstring>
#include <stdexcept>

using namespace dimina::bridge;
static void check(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
static JSValue eval(JSContext *ctx, const char *code) {
    JSValue result = JS_Eval(ctx, code, strlen(code), "<test>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        OwnedJSValue error(ctx, JS_GetException(ctx));
        auto text = encodeString(readString(ctx, error.value));
        JS_FreeValue(ctx, result);
        throw std::runtime_error(text);
    }
    return result;
}
int main() {
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(runtime);
    int status = 0;
    try {
        {
            OwnedJSValue input(ctx, eval(ctx, R"(
                var buffer = new Uint8Array(8 * 1024 * 1024);
                buffer.fill(173); buffer[0] = 0; buffer[buffer.length - 1] = 255;
                var text = '中文\0🎮\ud800';
                var payload = { data:buffer.buffer, empty:new ArrayBuffer(0), text,
                    entries:{'a.bin':{data:new Uint8Array([1,2,255]).buffer}},
                    list:[null, true, 42, 'ok'], ['__proto__']:'own property' };
                JSON.stringify = function() { throw new Error('must not serialize binary data'); };
                payload;
            )"));
            Value packet = fromJS(ctx, input.value);
            // Packet owns its bytes, independent of a subsequent JS mutation.
            OwnedJSValue mutation(ctx, eval(ctx, "buffer[1] = 7;"));
            OwnedJSValue global(ctx, JS_GetGlobalObject(ctx));
            JS_SetPropertyStr(ctx, global.value, "output", toJS(ctx, packet));
            OwnedJSValue valid(ctx, eval(ctx, R"(
                output.data instanceof ArrayBuffer && output.data.byteLength === 8388608 &&
                new Uint8Array(output.data)[1] === 173 && new Uint8Array(output.data)[8388607] === 255 &&
                output.empty instanceof ArrayBuffer && output.empty.byteLength === 0 && output.text === text &&
                new Uint8Array(output.entries['a.bin'].data)[2] === 255 &&
                output.list[0] === null && output.list[1] === true && output.list[2] === 42 &&
                Object.getPrototypeOf(output) === Object.prototype && output.__proto__ === 'own property';
            )"));
            check(JS_ToBool(ctx, valid.value), "binary contents, strings or nested values changed");
            OwnedJSValue setup(ctx, eval(ctx, "var events=[]; var DiminaServiceBridge={onMessage:function(m){events.push(m.text); return m.data.byteLength}};"));
            OwnedJSValue callback(ctx, deliverMessage(ctx, packet));
            check(!JS_IsException(callback.value), "native message delivery failed");
            int32_t length = 0;
            JS_ToInt32(ctx, &length, callback.value);
            check(length == 8388608, "callback lost binary data");
        }
        for (const char *code : {"var cycle={}; cycle.self=cycle; cycle", "({get data(){throw new Error('getter')}})",
                "var detached=new ArrayBuffer(1); detached.transfer(); ({data:detached})"}) {
            OwnedJSValue input(ctx, eval(ctx, code));
            bool rejected = false;
            try { fromJS(ctx, input.value); } catch (const std::exception &) { rejected = true; }
            check(rejected, "invalid bridge input was not rejected");
            if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
        }
        std::cout << "8 MiB binary round trip, ownership, nested/empty buffers, UTF-16, direct callback and errors passed\n";
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; status = 1; }
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return status;
}
