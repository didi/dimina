#pragma once

#if defined(DIMINA_WASM_JSC) ||                                                \
    (defined(__APPLE__) && !defined(DIMINA_WASM_QUICKJS))
#include <JavaScriptCore/JavaScriptCore.h>
typedef JSGlobalContextRef DiminaWasmContext;
#else
#include "quickjs.h"
typedef JSContext *DiminaWasmContext;
#endif

#ifdef __cplusplus
extern "C" {
#endif
// Both calls run on the owning Service JS thread. Dispose before releasing
// JSContext.
void dimina_wasm_install(DiminaWasmContext context);
void dimina_wasm_dispose(DiminaWasmContext context);
#ifdef __cplusplus
}
#endif
