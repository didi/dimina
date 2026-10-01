#pragma once
#ifdef DIMINA_WASM_APPLE
#define BH_PLATFORM_DARWIN 1
#if defined(__aarch64__) || defined(__arm64__)
#define BUILD_TARGET_AARCH64 1
#define BUILD_TARGET "AARCH64"
#elif defined(__x86_64__)
#define BUILD_TARGET_X86_64 1
#define BUILD_TARGET "X86_64"
#else
#error Unsupported Apple Wasm architecture
#endif
#endif
