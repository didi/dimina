# Vendored QuickJS

`upstream/` is an unmodified source snapshot from
[`bellard/quickjs`](https://github.com/bellard/quickjs) at the commit recorded
in `UPSTREAM_COMMIT`. Its license is preserved in `upstream/LICENSE`.

Do not edit the snapshot in place. Android and Harmony consume it through
`cmake/DiminaQuickJS.cmake`. Debugger-enabled builds copy only the required
build inputs into the platform build directory and apply
`third_party/quickjs-debugger/patches/quickjs.patch` there, so Debug and Release
builds never modify or share a patched source tree.

Use `scripts/update-native-dependencies.sh` to check or update the pinned
revision. An update is accepted only when the debugger patch still applies to
the new source snapshot.
