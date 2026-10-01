// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Dimina",
    platforms: [
        .iOS(.v14)
    ],
    products: [
        .library(
            name: "Dimina",
            targets: ["Dimina"]
        ),
        .library(name: "DiminaMapAMap", targets: ["DiminaMapAMap"])
    ],
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", exact: "5.12.0"),
        .package(url: "https://github.com/Tencent/MMKV.git", exact: "2.4.2"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
    ],
    targets: [
        // Keep these native targets aligned with third_party/wamr/Package.swift.
        // In-tree targets preserve versioned remote SwiftPM consumption.
        .target(name: "DiminaWamr", path: "third_party/wamr", sources: [
            "upstream/core/shared/platform/darwin/platform_init.c",
            "upstream/core/shared/platform/common/memory/mremap.c",
            "upstream/core/shared/platform/common/posix/posix_blocking_op.c",
            "upstream/core/shared/platform/common/posix/posix_malloc.c",
            "upstream/core/shared/platform/common/posix/posix_memmap.c",
            "upstream/core/shared/platform/common/posix/posix_sleep.c",
            "upstream/core/shared/platform/common/posix/posix_thread.c",
            "upstream/core/shared/platform/common/posix/posix_time.c",
            "upstream/core/shared/mem-alloc/ems/ems_alloc.c",
            "upstream/core/shared/mem-alloc/ems/ems_gc.c",
            "upstream/core/shared/mem-alloc/ems/ems_hmu.c",
            "upstream/core/shared/mem-alloc/ems/ems_kfc.c",
            "upstream/core/shared/mem-alloc/mem_alloc.c",
            "upstream/core/shared/utils/bh_assert.c",
            "upstream/core/shared/utils/bh_bitmap.c",
            "upstream/core/shared/utils/bh_common.c",
            "upstream/core/shared/utils/bh_hashmap.c",
            "upstream/core/shared/utils/bh_leb128.c",
            "upstream/core/shared/utils/bh_list.c",
            "upstream/core/shared/utils/bh_log.c",
            "upstream/core/shared/utils/bh_queue.c",
            "upstream/core/shared/utils/bh_vector.c",
            "upstream/core/shared/utils/runtime_timer.c",
            "upstream/core/iwasm/common/wasm_application.c",
            "upstream/core/iwasm/common/wasm_blocking_op.c",
            "upstream/core/iwasm/common/wasm_c_api.c",
            "upstream/core/iwasm/common/wasm_exec_env.c",
            "upstream/core/iwasm/common/wasm_loader_common.c",
            "upstream/core/iwasm/common/wasm_memory.c",
            "upstream/core/iwasm/common/wasm_native.c",
            "upstream/core/iwasm/common/wasm_runtime_common.c",
            "upstream/core/iwasm/common/wasm_shared_memory.c",
            "upstream/core/iwasm/interpreter/wasm_interp_fast.c",
            "upstream/core/iwasm/interpreter/wasm_loader.c",
            "upstream/core/iwasm/interpreter/wasm_runtime.c",
            "apple_invoke.S", "apple_helpers.c"
        ], publicHeadersPath: "include", cSettings: [
            .headerSearchPath("upstream/core/iwasm/interpreter"),
            .headerSearchPath("upstream/core/iwasm/include"),
            .headerSearchPath("upstream/core/shared/platform/darwin"),
            .headerSearchPath("upstream/core/shared/platform/include"),
            .headerSearchPath("upstream/core/shared/mem-alloc"),
            .headerSearchPath("upstream/core/iwasm/common"),
            .headerSearchPath("upstream/core/shared/utils"),
            .headerSearchPath("include"),
            .define("BH_FREE", to: "wasm_runtime_free"),
            .define("BH_MALLOC", to: "wasm_runtime_malloc"),
            .define("WASM_DISABLE_HW_BOUND_CHECK", to: "1"),
            .define("WASM_DISABLE_STACK_HW_BOUND_CHECK", to: "1"),
            .define("WASM_DISABLE_WAKEUP_BLOCKING_OP", to: "0"),
            .define("WASM_ENABLE_AOT_INTRINSICS", to: "0"),
            .define("WASM_ENABLE_BULK_MEMORY", to: "1"),
            .define("WASM_ENABLE_EXTENDED_CONST_EXPR", to: "0"),
            .define("WASM_ENABLE_FAST_INTERP", to: "1"),
            .define("WASM_ENABLE_INTERP", to: "1"),
            .define("WASM_ENABLE_MINI_LOADER", to: "0"),
            .define("WASM_ENABLE_MULTI_MODULE", to: "0"),
            .define("WASM_ENABLE_QUICK_AOT_ENTRY", to: "0"),
            .define("WASM_ENABLE_REF_TYPES", to: "1"),
            .define("WASM_ENABLE_SHARED_MEMORY", to: "0"),
            .define("WASM_ENABLE_SHRUNK_MEMORY", to: "1"),
            .define("WASM_GLOBAL_HEAP_SIZE", to: "10485760"),
            .define("WASM_HAVE_MREMAP", to: "0"),
            .define("DIMINA_WASM_APPLE"),
        ]),
        .target(name: "DiminaWasmBridge", dependencies: ["DiminaWamr"], path: "third_party/wamr/apple_bridge",
                sources: ["dimina_wasm.cpp"], publicHeadersPath: "include", cxxSettings: [
                    .define("DIMINA_WASM_JSC"),
                    .headerSearchPath("../upstream/core/iwasm/include"),
                ], linkerSettings: [.linkedFramework("JavaScriptCore")]),
        .target(
            name: "Dimina",
            dependencies: [
                "Alamofire",
                "MMKV",
                "ZIPFoundation",
                "DiminaWasmBridge",
            ],
            path: "iOS/dimina",
            exclude: [
                "ContentView.swift",
                "diminaApp.swift",
                "Assets.xcassets",
                "Preview Content",
                // Compiled by the optional DiminaMapAMap target, not the core SDK.
                "DiminaKit/Map/DMPAMapProvider.swift",
            ],
            sources: [
                "DiminaKit"
            ],
            resources: [
                .process("Resources/Assets.xcassets"),
                .copy("Resources/JsApp.bundle"),
                .copy("Resources/JsSdk.bundle"),
            ]
        ),
        .binaryTarget(
            name: "MAMapKit",
            url: "https://github.com/didi/dimina/releases/download/v1.7.5/MAMapKit-11.2.100.xcframework.zip",
            checksum: "bd991fb5990937b03e2d2b327ca90c7e4b6dab23f821195ce41284b27ae5eb1c"
        ),
        .binaryTarget(
            name: "AMapFoundationKit",
            url: "https://github.com/didi/dimina/releases/download/v1.7.5/AMapFoundationKit-1.9.1.xcframework.zip",
            checksum: "10103d8e64c8521f9a200164c1dbef75c9df988111c37758bcc18578fdebfca5"
        ),
        .target(
            name: "DiminaMapAMap",
            dependencies: ["Dimina", "MAMapKit", "AMapFoundationKit"],
            path: "iOS/dimina/DiminaKit/Map",
            exclude: ["DMPMapProvider.swift", "DMPNativeMapHost.swift"],
            sources: ["DMPAMapProvider.swift"],
            linkerSettings: [
                .linkedFramework("QuartzCore"), .linkedFramework("CoreLocation"),
                .linkedFramework("SystemConfiguration"), .linkedFramework("CoreTelephony"),
                .linkedFramework("Security"), .linkedFramework("OpenGLES"),
                .linkedFramework("CoreText"), .linkedFramework("CoreGraphics"),
                .linkedFramework("GLKit"), .linkedLibrary("z"), .linkedLibrary("c++"),
            ]
        )
    ],
    // Keep SwiftPM consumers aligned with the checked-in Xcode target until the SDK's shared
    // mutable registries have completed a strict-concurrency migration.
    swiftLanguageModes: [.v5],
    cxxLanguageStandard: .cxx17
)
