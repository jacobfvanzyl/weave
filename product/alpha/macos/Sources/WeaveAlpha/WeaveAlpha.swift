import AppKit
import WebKit

private final class AlphaAppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let resourceRoot: URL?

    init(resourceRoot: URL?) {
        self.resourceRoot = resourceRoot?.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard
            let requestURL = urlSchemeTask.request.url,
            requestURL.host == "app",
            let resourceRoot
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let requestedPath = requestURL.path == "/" ? "index.html" : String(requestURL.path.dropFirst())
        let resourceURL = resourceRoot.appendingPathComponent(requestedPath).standardizedFileURL
        let rootPath = resourceRoot.path.hasSuffix("/") ? resourceRoot.path : resourceRoot.path + "/"
        guard resourceURL.path.hasPrefix(rootPath), let data = try? Data(contentsOf: resourceURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = URLResponse(
            url: requestURL,
            mimeType: Self.mimeType(for: resourceURL.pathExtension),
            expectedContentLength: data.count,
            textEncodingName: Self.isText(resourceURL.pathExtension) ? "utf-8" : nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": "text/html"
        case "css": "text/css"
        case "js": "text/javascript"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "woff2": "font/woff2"
        default: "application/octet-stream"
        }
    }

    private static func isText(_ pathExtension: String) -> Bool {
        ["html", "css", "js", "json", "svg"].contains(pathExtension.lowercased())
    }
}
@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var scheme: AlphaAppSchemeHandler?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        let scheme = AlphaAppSchemeHandler(resourceRoot: Bundle.main.resourceURL?.appendingPathComponent("public"))
        self.scheme = scheme
        configuration.setURLSchemeHandler(scheme, forURLScheme: "weave")
        let shell = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Weave Alpha"
        window.contentView = shell
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        let acceptance = CommandLine.arguments.contains("--shell-acceptance")
        shell.load(URLRequest(url: URL(string: acceptance ? "weave://app/index.html?mock=chat&acceptance=1" : "weave://app/index.html")!))
        NSApp.activate(ignoringOtherApps: true)
        if acceptance {
            Task { @MainActor in
                for _ in 0..<150 {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    if let result = try? await shell.evaluateJavaScript("JSON.stringify(window.alphaAcceptance || null)"),
                       let json = result as? String, json != "null" {
                        try? Data(json.utf8).write(to: URL(fileURLWithPath: "/tmp/weave-shell-macos.json"), options: .atomic)
                        if let image = try? await shell.takeSnapshot(configuration: nil),
                           let tiff = image.tiffRepresentation,
                           let bitmap = NSBitmapImageRep(data: tiff),
                           let png = bitmap.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: "/tmp/weave-shell-macos.png"), options: .atomic)
                        }
                        return
                    }
                }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
private enum WeaveAlpha {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}
