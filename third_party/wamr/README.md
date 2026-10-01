# Vendored WAMR

The interpreter is pinned to [WAMR 2.4.5](https://github.com/bytecodealliance/wasm-micro-runtime/tree/WAMR-2.4.5), commit `25bd7eb63e828e4bd242cc9b38d260b4b31c6605`. `UPSTREAM_COMMIT` and `VERSION` record this pin. The vendored `upstream/core` and `upstream/build-scripts` retain upstream copyright notices; see `LICENSE` and `ATTRIBUTIONS.md`.

Dimina builds the fast interpreter with bulk memory and reference types, software bounds checks, and no AOT, JIT, SIMD, WASI, or shared memory. CMake is used by Android and Harmony; Xcode uses the local Swift package, while the root SDK Swift package declares the same in-tree native targets to preserve versioned remote dependency support. `apple_invoke.S` selects the native-call assembly for arm64 or x86_64 without relying on a build machine's architecture.

The only change under `upstream/` is the guarded include of `dimina_wamr_config.h` in `core/shared/utils/bh_platform.h`. It selects the Apple build target from compiler architecture macros for SwiftPM. Keep this patch when refreshing the upstream source.

`native/wasm/wamr_helpers.c` accesses the pinned C API internals for host memory growth and table function references. Review those layouts when changing the WAMR revision. The JavaScript bindings and tests live in [native/wasm](../../native/wasm/README.md).
