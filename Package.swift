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
        )
    ],
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", exact: "5.12.0"),
        .package(url: "https://github.com/Tencent/MMKV.git", exact: "2.4.0"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
    ],
    targets: [
        .target(
            name: "Dimina",
            dependencies: [
                "Alamofire",
                "MMKV",
                "ZIPFoundation",
            ],
            path: "iOS/dimina",
            exclude: [
                "ContentView.swift",
                "diminaApp.swift",
                "Assets.xcassets",
                "Preview Content",
            ],
            sources: [
                "DiminaKit"
            ],
            resources: [
                .process("Resources/Assets.xcassets"),
                .copy("Resources/JsApp.bundle"),
                .copy("Resources/JsSdk.bundle"),
            ]
        )
    ]
)
