# QuickJS debugger integration

This directory contains Dimina's port of the debugger transport originally
developed in [`koush/quickjs`](https://github.com/koush/quickjs). The port is
compiled only when `DIMINA_ENABLE_QUICKJS_DEBUGGER` is enabled.

`patches/quickjs.patch` targets upstream QuickJS commit
`04be246001599f5995fa2f2d8c91a0f198d3f34c` (version 2026-06-04). It adds the
small set of interpreter hooks and internal adapters required by the debugger.
The remaining source files implement the DAP-compatible wire protocol and the
POSIX TCP transport used by Harmony and prepared for future Android/iOS
integrations.

The component layout keeps public headers, implementation, the pinned upstream
patch, and protocol tests independent from any platform SDK:

```text
include/   Public debugger API
src/       Protocol core and POSIX transport
patches/   Patch applied to the pinned QuickJS checkout
tests/     Standalone protocol harness and regression test
```

Platform projects own only their build flags, runtime lifecycle wiring, and
device-to-host port forwarding.

The source remains under the QuickJS MIT license in `LICENSE`.

Run the end-to-end transport regression test against the vendored QuickJS
snapshot:

```sh
python3 tests/protocol_test.py
```

An alternate clean QuickJS source directory can be passed explicitly when
checking an upstream update.
