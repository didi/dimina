# Native Wasm bindings

`dimina_wasm.cpp` bridges the vendored WAMR interpreter to QuickJS and JavaScriptCore. `dimina_wasm_install` runs before the Service SDK loads, and `dimina_wasm_dispose` runs on the same JS thread before its context is destroyed. The public JS wrapper is `fe/packages/service/src/core/webassembly.js`; the supported contract and integration example are in [WXWebAssembly](../../docs/WXWebAssembly.md).

Build and run from the repository root with CMake 3.22+, a C/C++ toolchain and Node.js:

```sh
cmake -S native/wasm/tests -B /tmp/dimina-wasm-tests -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/dimina-wasm-tests -j 8
node native/wasm/tests/run.mjs /tmp/dimina-wasm-tests
```

The tests execute genuine QuickJS contexts and, on macOS, JavaScriptCore contexts. Each executable runs two contexts concurrently and disposes both. Fixtures cover live shared memory, growth and detachment before a JS import, function tables, trap recovery, original callback exceptions, numeric values including i64, multi-value results and mutable globals. The transfer regression rejects direct, prototype and `Reflect.apply` calls to `transfer` and `transferToFixedLength` on Wasm buffers, including buffers recreated after growth. It also checks ordinary ArrayBuffer transfer after validation, Wasm buffer slicing and growth after validation or compilation, application changes to the WeakSet prototype, and final buffer detachment on teardown. `fixtures/*.wat` are the readable sources of the checked-in binaries; regenerate with WABT's `wat2wasm` when editing them.

To test the full libpag package, download the exact version to a temporary directory and pass its extracted package directory:

```sh
mkdir -p /tmp/dimina-libpag
npm pack libpag-miniprogram@4.5.85 --pack-destination /tmp/dimina-libpag
tar -xzf /tmp/dimina-libpag/libpag-miniprogram-4.5.85.tgz -C /tmp/dimina-libpag
node native/wasm/tests/run.mjs /tmp/dimina-wasm-tests /tmp/dimina-libpag/package
```

An optional third argument is the built Service SDK `service.js`. This runs its real `modDefine` / `modRequire` import path, checks capability before importing libpag, then initializes PAG, parses the red PAG fixture, and forces 48 MiB heap growth. Native I/O and browser rendering are outside this host test: its file adapter supplies bytes from the package's actual Brotli file, verified against the uncompressed binary. No WebGL calls or video decoding are mocked as a successful render.

`fixtures/red.pag` comes from [Tencent/libpag assets/red.pag](https://github.com/Tencent/libpag/blob/main/assets/red.pag), licensed under [Apache-2.0](https://github.com/Tencent/libpag/blob/main/LICENSE.txt). The two small Wasm fixtures are authored for Dimina. The libpag JS and Wasm package are external test inputs, not vendored in this repository.

Harmony's actual ArkTS package resolver / file bridge can be checked with:

```sh
node --test harmony/scripts/wasm-package.test.mjs
```

The Android and iOS package-read tests are in their existing `FileSystemCacheTest` / `DMPFileSystemCacheTests` suites. Target-device WebGL rendering and video playback need separate integration verification; host test success does not establish those results.

The regression checks were also tested with isolated minimal ablations. Omitting native engine installation fails the Service SDK startup capability assertion. Omitting the buffer refresh before a JS import fails `detach before host callback` in both QuickJS and JavaScriptCore. Routing package reads through the sandbox-only resolver fails loading `/utils/module.wasm.br` with `permission denied`. Omitting buffer detachment during app teardown fails `Live Wasm buffer survived app teardown` in both engines. Restoring each mechanism passes the same tests. The compiler asset tests failed before the fix because both business and npm Wasm files were missing, then passed after preserving binary resources. No ablation code is part of the implementation.

Before adding the native transfer guard, the transfer regression failed in QuickJS at `Wasm buffer initial direct transfer must throw TypeError`. After adding the guard but before taking independent input snapshots, JavaScriptCore failed at `transfer detaches an ordinary buffer` after validation; validating a Wasm buffer followed by growth also crashed the host. With both mechanisms present, the runtime and transfer regressions pass in both engines, including teardown. The input checks also reject invalid module bytes without consulting the source buffer's constructor or species.
