// BundledApp: the app's web build carried inside Vyre.app (Contents/Resources/app, `expo export -p web` with baseUrl /app, put there when the app is built).
// A Mac whose Vyre runs on a server has no local vyred to serve /app/, so the window serves these files itself through its scheme handler, and the
// page runs as a browser with no box of its own. The files are the same ones vyred serves; the export is a single-page app (output "single"), so every
// route of the app is index.html.
//
// Pure (Foundation only), so the Swift tests run it: `resolve` maps a request path to a file inside the folder, never outside it.

import Foundation

public enum BundledApp {
    /// Where the web build is: VYRE_CAPSULE_APP_DIR (tests, a hand-run check), else Contents/Resources/app. Nil when this app was built without it.
    public static func locate(env: [String: String] = ProcessInfo.processInfo.environment, resources: String? = Bundle.main.resourcePath) -> String? {
        let dir = env["VYRE_CAPSULE_APP_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? resources.map { $0 + "/app" }
        guard let dir, dir.hasPrefix("/"), FileManager.default.fileExists(atPath: dir + "/index.html") else { return nil }
        return dir
    }

    public enum Answer: Equatable {
        /// This file, with this content type.
        case file(path: String, mime: String)
        /// No such thing here (a file with an extension that is not in the build, or a call that needs a vyred).
        case missing
    }

    /// A request path, as the page sends it ("/app/_expo/static/js/web/entry.js", "/app/u/now"), to what answers it. The prefix /app is the build's base URL.
    public static func resolve(path rawPath: String, in dir: String) -> Answer {
        var path = rawPath.removingPercentEncoding ?? rawPath
        if path == "/app" { path = "/app/" }
        guard path.hasPrefix("/app/") else { return .missing }
        // Calls to the box (/v1/...) have no vyred to answer them here: the page uses the relay instead.
        path.removeFirst("/app".count)
        let base = URL(fileURLWithPath: dir).standardizedFileURL.path
        let wanted = URL(fileURLWithPath: base + path).standardizedFileURL.path
        guard wanted == base || wanted.hasPrefix(base + "/") else { return .missing }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: wanted, isDirectory: &isDir), !isDir.boolValue { return .file(path: wanted, mime: mime(of: wanted)) }
        // A route of the app (no extension) is the single page; a missing asset is missing.
        if (wanted as NSString).pathExtension.isEmpty { return .file(path: base + "/index.html", mime: "text/html; charset=utf-8") }
        return .missing
    }

    public static func mime(of path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
