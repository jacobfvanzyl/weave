// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TrackpadCore",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [.library(name: "TrackpadCore", targets: ["TrackpadCore"])],
    targets: [
        .target(name: "TrackpadCore"),
        .testTarget(name: "TrackpadCoreTests", dependencies: ["TrackpadCore"])
    ]
)
