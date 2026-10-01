#include "dimina_wasm.h"
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
static std::string read(const char *path) {
  std::ifstream input(path);
  std::stringstream output;
  output << input.rdbuf();
  return output.str();
}
#ifdef DIMINA_WASM_JSC
static bool evaluate(DiminaWasmContext ctx, const std::string &code) {
  auto script = JSStringCreateWithUTF8CString(code.c_str());
  JSValueRef exception = nullptr;
  JSEvaluateScript(ctx, script, nullptr, nullptr, 1, &exception);
  JSStringRelease(script);
  if (!exception)
    return true;
  auto text = JSValueToStringCopy(ctx, exception, nullptr);
  char buffer[4096];
  JSStringGetUTF8CString(text, buffer, sizeof(buffer));
  JSStringRelease(text);
  std::cerr << buffer << std::endl;
  return false;
}
#else
static bool evaluate(DiminaWasmContext ctx, const std::string &code) {
  auto result = JS_Eval(ctx, code.data(), code.size(), "wasm-test.js",
                        JS_EVAL_TYPE_GLOBAL);
  bool ok = !JS_IsException(result);
  JS_FreeValue(ctx, result);
  if (!ok) {
    auto exception = JS_GetException(ctx);
    auto message = JS_ToCString(ctx, exception);
    std::cerr << (message ? message : "JS exception") << std::endl;
    JS_FreeCString(ctx, message);
    auto stack = JS_GetPropertyStr(ctx, exception, "stack");
    auto text = JS_ToCString(ctx, stack);
    std::cerr << (text ? text : "JS exception") << std::endl;
    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, exception);
  }
  return ok;
}
#endif
static bool runOnce(int argc, char **argv) {
#ifdef DIMINA_WASM_JSC
  auto ctx = JSGlobalContextCreate(nullptr);
#else
  auto runtime = JS_NewRuntime();
  JS_SetMaxStackSize(runtime, 8 * 1024 * 1024);
  auto ctx = JS_NewContext(runtime);
#endif
  dimina_wasm_install(ctx);
  bool success = true;
  for (int n = 1; n < argc && success; n++)
    success = evaluate(ctx, read(argv[n]));
#ifndef DIMINA_WASM_JSC
  JSContext *pendingContext;
  int status;
  while (success &&
         (status = JS_ExecutePendingJob(runtime, &pendingContext)) != 0) {
    if (status < 0) {
      success = false;
      auto error = JS_GetException(pendingContext);
      auto text = JS_ToCString(pendingContext, error);
      std::cerr << (text ? text : "Promise error") << std::endl;
      JS_FreeCString(pendingContext, text);
      JS_FreeValue(pendingContext, error);
    }
  }
#endif
  if (success)
    success = evaluate(ctx, "if(globalThis.__testFailure)throw new "
                            "Error(globalThis.__testFailure);if(globalThis.__"
                            "expectsAsync&&!globalThis.__testComplete)throw "
                            "new Error('Async Wasm test unfinished');");
  dimina_wasm_dispose(ctx);
  if (success)
    success = evaluate(ctx, "if(globalThis.__teardownBuffers?.some(buffer=>"
                            "buffer.byteLength!==0))throw new Error('Live Wasm "
                            "buffer survived app teardown');");
#ifdef DIMINA_WASM_JSC
  JSGlobalContextRelease(ctx);
#else
  JS_FreeContext(ctx);
  JS_FreeRuntime(runtime);
#endif
  if (success)
    std::cout << "PASS" << std::endl;
  return success;
}

int main(int argc, char **argv) {
  bool first = false;
  std::thread other([&] { first = runOnce(argc, argv); });
  bool second = runOnce(argc, argv);
  other.join();
  return first && second ? 0 : 1;
}
