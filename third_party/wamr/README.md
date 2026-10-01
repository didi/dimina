# Vendored WAMR

The interpreter is pinned to [WAMR 2.4.5](https://github.com/bytecodealliance/wasm-micro-runtime/tree/WAMR-2.4.5), commit `25bd7eb63e828e4bd242cc9b38d260b4b31c6605`. `UPSTREAM_COMMIT` and `VERSION` record this pin. The vendored `upstream/core` and `upstream/build-scripts` retain upstream copyright notices; see `LICENSE` and `ATTRIBUTIONS.md`.

Dimina builds the fast interpreter with bulk memory and reference types, software bounds checks, and no AOT, JIT, SIMD, WASI, or shared memory. CMake is used by Android and Harmony; Xcode uses the local Swift package, while the root SDK Swift package declares the same in-tree native targets to preserve versioned remote dependency support. `apple_invoke.S` selects the native-call assembly for arm64 or x86_64 without relying on a build machine's architecture.

Local changes under `upstream/`:

- `core/shared/utils/bh_platform.h` includes `dimina_wamr_config.h` under a guard to select the Apple build target from compiler architecture macros for SwiftPM.
- `core/iwasm/interpreter/wasm_loader.c` marks exported memory as potentially growing before preparing functions. A JS host can grow and inspect that memory even without Wasm `memory.grow` or `memory.size` instructions, including through imported callbacks. This preserves the declared 64 KiB page size and maximum, including when `WASM_ENABLE_SHRUNK_MEMORY` is enabled, and prevents compilation from treating memory as fixed across callbacks. Private memories without size/growth instructions retain upstream shrinking and page consolidation.

Keep these patches when refreshing the upstream source.

`native/wasm/wamr_helpers.c` accesses the pinned C API internals for host memory growth and table function references. Review those layouts when changing the WAMR revision. The JavaScript bindings and tests live in [native/wasm](../../native/wasm/README.md).
