// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WindowCaptureSCK",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "weave-window-capture-sck", targets: ["WindowCaptureSCK"]),
    ],
    targets: [
        .executableTarget(
            name: "WindowCaptureSCK",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreImage"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
    ]
)
