# Binary file bridge

Native engines advertise `DiminaServiceBridge.fileBinarySupported`. The Service
file adapter then passes ArrayBuffers directly, including the selected byte range
of a typed array or DataView. Older engines continue to receive the existing
Base64 payload through the shared native codecs when available.

Android uses `ByteArray` inside structured `JSONObject` messages and `JSValue.NATIVE`
returns. Harmony keeps file operations in the ArkTS Worker and converts messages
through N-API. Both use the same QuickJS conversion and direct `onMessage` call.
iOS uses `Data` and JavaScriptCore ArrayBuffers with an owned native allocation.

The bridge copies bytes to establish ownership. Queued messages contain native
values, never JS runtime handles; each destination creates its ArrayBuffers on
the owning JS thread. File data does not pass through Base64, JSON, or generated
callback source. Existing script and callback queues retain their ordering.

Run the shared QuickJS tests from the repository root:

```sh
cmake -S native/bridge/tests -B /tmp/dimina-bridge-tests -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/dimina-bridge-tests -j
ctest --test-dir /tmp/dimina-bridge-tests --output-on-failure
```

To include the host N-API integration tests, configure with
`-DNODE_INCLUDE_DIR=/path/to/node/include/node`. This exercises the production
N-API conversion through Node and QuickJS; it does not replace a Harmony SDK
build or device run.

The tests cover 8 MiB payloads, independent byte ownership, nested and empty
buffers, UTF-16 strings, direct callbacks, and conversion errors. Platform
regressions are in `DMPFileSystemCacheTests`, `QuickJSEngineTest`,
`FileSystemCacheTest`, and `harmony/scripts/file-binary.test.mjs`.
