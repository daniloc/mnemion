// swift-tools-version: 6.2
import PackageDescription

// The shared client core for every Apple surface (iPhone, Mac, Vision Pro, and
// later Watch). Platform-neutral: no UIKit/AppKit, only Foundation + Security.
let package = Package(
    name: "MnemionKit",
    platforms: [.iOS(.v26), .macOS(.v26), .visionOS(.v26), .watchOS(.v26)],
    products: [
        .library(name: "MnemionKit", targets: ["MnemionKit"]),
    ],
    targets: [
        .target(name: "MnemionKit"),
        .testTarget(name: "MnemionKitTests", dependencies: ["MnemionKit"]),
    ]
)
