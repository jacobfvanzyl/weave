// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.1"),
        .package(name: "CapacitorKeyboard", path: "../../../../node_modules/.bun/@capacitor+keyboard@8.0.5+767ac80cbab8ae50/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorLocalNotifications", path: "../../../../node_modules/.bun/@capacitor+local-notifications@8.2.0+767ac80cbab8ae50/node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorPreferences", path: "../../../../node_modules/.bun/@capacitor+preferences@8.0.1+767ac80cbab8ae50/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorStatusBar", path: "../../../../node_modules/.bun/@capacitor+status-bar@8.0.2+767ac80cbab8ae50/node_modules/@capacitor/status-bar")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar")
            ]
        )
    ]
)
