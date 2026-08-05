// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CursorUsageHud",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CursorUsageHud",
            path: "Sources",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
    ]
)
