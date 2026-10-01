#pragma once
#include "dimina_wasm.h"
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace dimina_wasm {
#ifdef DIMINA_WASM_JSC
using Raw = JSValueRef;
#else
using Raw = JSValue;
#endif
struct Value {
  DiminaWasmContext ctx;
  Raw raw;
  Value(DiminaWasmContext c, Raw v) : ctx(c), raw(v) {
#ifdef DIMINA_WASM_JSC
    JSValueProtect(ctx, raw);
#endif
  }
  Value(const Value &v) : ctx(v.ctx), raw(v.raw) {
#ifdef DIMINA_WASM_JSC
    JSValueProtect(ctx, raw);
#else
    raw = JS_DupValue(ctx, raw);
#endif
  }
  ~Value() {
#ifdef DIMINA_WASM_JSC
    JSValueUnprotect(ctx, raw);
#else
    JS_FreeValue(ctx, raw);
#endif
  }
  Value &operator=(const Value &) = delete;
};
struct Thrown {
  Value value;
  explicit Thrown(const Value &v) : value(v) {}
};
#ifdef DIMINA_WASM_JSC
struct String {
  JSStringRef ref;
  explicit String(const std::string &s)
      : ref(JSStringCreateWithUTF8CString(s.c_str())) {}
  ~String() { JSStringRelease(ref); }
};
inline Value checked(DiminaWasmContext c, Raw v, Raw exception) {
  if (exception)
    throw Thrown(Value(c, exception));
  return Value(c, v);
}
#else
inline Value checked(DiminaWasmContext c, Raw v) {
  if (JS_IsException(v)) {
    Value e(c, JS_GetException(c));
    throw Thrown(e);
  }
  return Value(c, v);
}
#endif
struct VM {
  DiminaWasmContext ctx;
  Value evaluate(const char *source) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto result = JSEvaluateScript(ctx, String(source).ref, nullptr,
                                   String("dimina-wasm-intrinsics").ref, 1, &e);
    return checked(ctx, result, e);
#else
    return checked(ctx, JS_Eval(ctx, source, std::char_traits<char>::length(source),
                               "dimina-wasm-intrinsics", JS_EVAL_TYPE_GLOBAL));
#endif
  }
  Value undefined() {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSValueMakeUndefined(ctx));
#else
    return Value(ctx, JS_UNDEFINED);
#endif
  }
  Value null() {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSValueMakeNull(ctx));
#else
    return Value(ctx, JS_NULL);
#endif
  }
  Value number(double n) {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSValueMakeNumber(ctx, n));
#else
    return Value(ctx, JS_NewFloat64(ctx, n));
#endif
  }
  Value boolean(bool b) {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSValueMakeBoolean(ctx, b));
#else
    return Value(ctx, JS_NewBool(ctx, b));
#endif
  }
  Value string(const std::string &s) {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSValueMakeString(ctx, String(s).ref));
#else
    return Value(ctx, JS_NewStringLen(ctx, s.data(), s.size()));
#endif
  }
  Value object() {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSObjectMake(ctx, nullptr, nullptr));
#else
    return checked(ctx, JS_NewObject(ctx));
#endif
  }
  Value array() {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    Raw result = JSObjectMakeArray(ctx, 0, nullptr, &e);
    return checked(ctx, result, e);
#else
    return checked(ctx, JS_NewArray(ctx));
#endif
  }
  Value get(const Value &v, const std::string &key) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto o = JSValueToObject(ctx, v.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    Raw result = JSObjectGetProperty(ctx, o, String(key).ref, &e);
    return checked(ctx, result, e);
#else
    return checked(ctx, JS_GetPropertyStr(ctx, v.raw, key.c_str()));
#endif
  }
  void set(const Value &v, const std::string &key, const Value &data) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto o = JSValueToObject(ctx, v.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    JSObjectSetProperty(ctx, o, String(key).ref, data.raw,
                        kJSPropertyAttributeNone, &e);
    if (e)
      throw Thrown(Value(ctx, e));
#else
    if (JS_SetPropertyStr(ctx, v.raw, key.c_str(), JS_DupValue(ctx, data.raw)) <
        0)
      throw Thrown(Value(ctx, JS_GetException(ctx)));
#endif
  }
  double numeric(const Value &v) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto result = JSValueToNumber(ctx, v.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    return result;
#else
    double result;
    if (JS_ToFloat64(ctx, &result, v.raw))
      throw Thrown(Value(ctx, JS_GetException(ctx)));
    return result;
#endif
  }
  int32_t i32(const Value &v) {
#ifdef DIMINA_WASM_JSC
    double n = numeric(v);
    if (!std::isfinite(n))
      return 0;
    double wrapped = std::fmod(std::trunc(n), 4294967296.0);
    if (wrapped < 0)
      wrapped += 4294967296.0;
    return static_cast<int32_t>(static_cast<uint32_t>(wrapped));
#else
    int32_t n;
    if (JS_ToInt32(ctx, &n, v.raw))
      throw Thrown(Value(ctx, JS_GetException(ctx)));
    return n;
#endif
  }
  std::string text(const Value &v) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto s = JSValueToStringCopy(ctx, v.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    std::vector<char> data(JSStringGetMaximumUTF8CStringSize(s));
    JSStringGetUTF8CString(s, data.data(), data.size());
    JSStringRelease(s);
    return data.data();
#else
    size_t size;
    auto s = JS_ToCStringLen(ctx, &size, v.raw);
    if (!s)
      throw Thrown(Value(ctx, JS_GetException(ctx)));
    std::string result(s, size);
    JS_FreeCString(ctx, s);
    return result;
#endif
  }
  Value call(const Value &fn, const Value &self,
             const std::vector<Value> &args) {
    std::vector<Raw> raw;
    for (auto &a : args)
      raw.push_back(a.raw);
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto f = JSValueToObject(ctx, fn.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    JSObjectRef receiver = JSValueIsObject(ctx, self.raw)
                               ? JSValueToObject(ctx, self.raw, nullptr)
                               : nullptr;
    auto result =
        JSObjectCallAsFunction(ctx, f, receiver, raw.size(), raw.data(), &e);
    return checked(ctx, result, e);
#else
    return checked(ctx, JS_Call(ctx, fn.raw, self.raw, raw.size(), raw.data()));
#endif
  }
  Value global() {
#ifdef DIMINA_WASM_JSC
    return Value(ctx, JSContextGetGlobalObject(ctx));
#else
    return Value(ctx, JS_GetGlobalObject(ctx));
#endif
  }
  Value construct(const Value &fn, const std::vector<Value> &args) {
    std::vector<Raw> raw;
    for (auto &a : args)
      raw.push_back(a.raw);
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto f = JSValueToObject(ctx, fn.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    auto result = JSObjectCallAsConstructor(ctx, f, raw.size(), raw.data(), &e);
    return checked(ctx, result, e);
#else
    return checked(ctx,
                   JS_CallConstructor(ctx, fn.raw, raw.size(), raw.data()));
#endif
  }
  bool callable(const Value &v) {
#ifdef DIMINA_WASM_JSC
    return JSValueIsObject(ctx, v.raw) &&
           JSObjectIsFunction(ctx, JSValueToObject(ctx, v.raw, nullptr));
#else
    return JS_IsFunction(ctx, v.raw);
#endif
  }
  uint8_t *bytes(const Value &v, size_t &size) {
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto o = JSValueToObject(ctx, v.raw, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    auto result =
        static_cast<uint8_t *>(JSObjectGetArrayBufferBytesPtr(ctx, o, &e));
    if (e)
      throw Thrown(Value(ctx, e));
    size = JSObjectGetArrayBufferByteLength(ctx, o, &e);
    if (e)
      throw Thrown(Value(ctx, e));
    return result;
#else
    auto result = JS_GetArrayBuffer(ctx, &size, v.raw);
    if (!result && JS_HasException(ctx))
      throw Thrown(Value(ctx, JS_GetException(ctx)));
    return result;
#endif
  }
  Value buffer(uint8_t *data, size_t size) {
    // State owns the store until every buffer is detached on the JS thread.
    // GC deallocators must never release a WAMR store on another thread.
#ifdef DIMINA_WASM_JSC
    Raw e = nullptr;
    auto result = JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx, data, size, [](void *, void *) {}, nullptr, &e);
    return checked(ctx, result, e);
#else
    // State retains every live buffer and its store, then detaches buffers
    // before teardown. QuickJS invokes free_func both at detachment and
    // finalization; it must be idempotent.
    return checked(ctx, JS_NewArrayBuffer(
                            ctx, data, size, [](JSRuntime *, void *, void *) {},
                            nullptr, false));
#endif
  }
  void detach(const Value &buffer, const Value *intrinsic = nullptr) {
#ifdef DIMINA_WASM_JSC
    // transfer(0) detaches without reading bytes relocated by memory.grow.
    auto fn = intrinsic ? *intrinsic : get(buffer, "transfer");
    call(fn, buffer, {number(0)});
#else
    JS_DetachArrayBuffer(ctx, buffer.raw);
#endif
  }
  [[noreturn]] void error(const char *kind, const std::string &message) {
    auto scope = std::string(kind) == "CompileError" ||
                         std::string(kind) == "LinkError" ||
                         std::string(kind) == "RuntimeError"
                     ? get(global(), "WXWebAssembly")
                     : global();
    auto ctor = get(scope, kind);
    auto result = construct(ctor, {string(message)});
    throw Thrown(result);
  }
};
} // namespace dimina_wasm
