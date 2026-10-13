# Vendored QuickJS

`upstream/` is an unmodified source snapshot from
[`bellard/quickjs`](https://github.com/bellard/quickjs) at the commit recorded
in `UPSTREAM_COMMIT`. Its license is preserved in `upstream/LICENSE`.

Do not edit the snapshot in place. Android and Harmony consume it through
`cmake/DiminaQuickJS.cmake`. Debugger-enabled builds copy only the required
build inputs into the platform build directory and apply
`third_party/quickjs-debugger/patches/quickjs.patch` there, so Debug and Release
builds never modify or share a patched source tree.

Harmony also applies `patches/bridge-data.patch` in a build-local copy through
the `SOURCE_PATCH` argument. It appends unescaped Latin-1 JSON string spans in
bulk; escaping and UTF-16 strings still use the upstream path. It also exposes
`JS_NewArrayBufferOwned` to adopt independent native frame allocations while
charging their capacity to the runtime memory and GC budgets. Ownership stays
with the caller on failure. Android does not opt into this overlay. The overlay
hash is part of the preparation stamp.


Use `scripts/update-native-dependencies.sh --check` to validate the pinned
revision and snapshot without contacting upstream. Use `--check-updates` to
compare the pins with upstream master, and run `--update` only when intentionally
upgrading and retesting the native SDKs. A QuickJS update is accepted only when
the debugger patch still applies to the new source snapshot.
