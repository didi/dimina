#!/usr/bin/env bash

set -euo pipefail

usage() {
    echo "Usage: $0 <android|harmony> [iterations]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage
    exit 2
fi

platform="$1"
iterations="${2:-64}"
if [[ ! "$iterations" =~ ^[0-9]+$ ]] || ((iterations < 1 || iterations > 10000)); then
    echo "iterations must be an integer from 1 to 10000" >&2
    exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
test_source_dir="${repository_root}/tests/native"
test_target="dimina_libuv_lifecycle_test"
remote_test_path="/data/local/tmp/${test_target}"

configure_android() {
    local sdk_root="${ANDROID_SDK_ROOT:-}"
    if [[ -z "$sdk_root" && -f "${repository_root}/android/local.properties" ]]; then
        sdk_root="$(sed -n 's/^sdk\.dir=//p' "${repository_root}/android/local.properties" | head -n 1)"
    fi
    if [[ -z "$sdk_root" ]]; then
        echo "ANDROID_SDK_ROOT is not set and android/local.properties has no sdk.dir" >&2
        exit 1
    fi

    local ndk_root="${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-}}"
    if [[ -z "$ndk_root" ]]; then
        ndk_root="$(find "${sdk_root}/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
    fi
    if [[ -z "$ndk_root" || ! -f "${ndk_root}/build/cmake/android.toolchain.cmake" ]]; then
        echo "Cannot find an Android NDK; set ANDROID_NDK_ROOT" >&2
        exit 1
    fi

    local cmake_bin="${sdk_root}/cmake/3.22.1/bin/cmake"
    local ninja_bin="${sdk_root}/cmake/3.22.1/bin/ninja"
    local build_dir="${repository_root}/android/engine_qjs/.cxx/libuv-lifecycle-test/arm64-v8a"
    if [[ ! -x "$cmake_bin" || ! -x "$ninja_bin" ]]; then
        echo "Android SDK CMake 3.22.1 is required" >&2
        exit 1
    fi

    "$cmake_bin" -S "$test_source_dir" -B "$build_dir" -G Ninja \
        -DCMAKE_BUILD_TYPE=Debug \
        -DCMAKE_MAKE_PROGRAM="$ninja_bin" \
        -DCMAKE_TOOLCHAIN_FILE="${ndk_root}/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI=arm64-v8a \
        -DANDROID_PLATFORM=android-26
    "$cmake_bin" --build "$build_dir" --target "$test_target" --parallel 4

    local adb_bin="${sdk_root}/platform-tools/adb"
    if [[ -n "${ANDROID_SERIAL:-}" ]]; then
        "$adb_bin" -s "$ANDROID_SERIAL" get-state >/dev/null
        "$adb_bin" -s "$ANDROID_SERIAL" push "${build_dir}/${test_target}" "$remote_test_path" >/dev/null
        "$adb_bin" -s "$ANDROID_SERIAL" shell chmod 755 "$remote_test_path"
        "$adb_bin" -s "$ANDROID_SERIAL" shell "$remote_test_path" "$iterations"
    else
        "$adb_bin" get-state >/dev/null
        "$adb_bin" push "${build_dir}/${test_target}" "$remote_test_path" >/dev/null
        "$adb_bin" shell chmod 755 "$remote_test_path"
        "$adb_bin" shell "$remote_test_path" "$iterations"
    fi
}

configure_harmony() {
    local sdk_root="${DEVECO_SDK_HOME:-/Applications/DevEco-Studio.app/Contents/sdk}"
    local cmake_bin="${sdk_root}/default/openharmony/native/build-tools/cmake/bin/cmake"
    local ninja_bin="${sdk_root}/default/openharmony/native/build-tools/cmake/bin/ninja"
    local toolchain_file="${sdk_root}/default/hms/native/build/cmake/hmos.toolchain.cmake"
    local hdc_bin="${sdk_root}/default/openharmony/toolchains/hdc"
    local build_dir="${repository_root}/harmony/dimina/.cxx/libuv-lifecycle-test/arm64-v8a"

    if [[ ! -x "$cmake_bin" || ! -x "$ninja_bin" || ! -f "$toolchain_file" ]]; then
        echo "Cannot find the DevEco Studio native toolchain; set DEVECO_SDK_HOME" >&2
        exit 1
    fi

    "$cmake_bin" -S "$test_source_dir" -B "$build_dir" -G Ninja \
        -DCMAKE_BUILD_TYPE=Debug \
        -DCMAKE_MAKE_PROGRAM="$ninja_bin" \
        -DCMAKE_SYSTEM_NAME=OHOS \
        -DCMAKE_OHOS_ARCH_ABI=arm64-v8a \
        -DOHOS_ARCH=arm64-v8a \
        -DOHOS_SDK_NATIVE="${sdk_root}/default/openharmony/native" \
        -DHMOS_SDK_NATIVE="${sdk_root}/default/hms/native" \
        -DCMAKE_TOOLCHAIN_FILE="$toolchain_file"
    "$cmake_bin" --build "$build_dir" --target "$test_target" --parallel 4

    local target_list
    target_list="$("$hdc_bin" list targets 2>&1)"
    if [[ -z "$target_list" || "$target_list" == *"[Empty]"* || "$target_list" == *"[Fail]"* ]]; then
        echo "No usable Harmony device is connected: ${target_list:-empty target list}" >&2
        exit 1
    fi

    run_hdc() {
        local output
        if [[ -n "${HDC_TARGET:-}" ]]; then
            output="$("$hdc_bin" -t "$HDC_TARGET" "$@" 2>&1)"
        else
            output="$("$hdc_bin" "$@" 2>&1)"
        fi
        if [[ "$output" == *"[Fail]"* ]]; then
            echo "$output" >&2
            return 1
        fi
        if [[ -n "$output" ]]; then
            echo "$output"
        fi
    }

    run_hdc file send "${build_dir}/${test_target}" "$remote_test_path"
    run_hdc shell chmod 755 "$remote_test_path"
    run_hdc shell "$remote_test_path" "$iterations"
}

case "$platform" in
    android)
        configure_android
        ;;
    harmony)
        configure_harmony
        ;;
    *)
        usage
        exit 2
        ;;
esac
