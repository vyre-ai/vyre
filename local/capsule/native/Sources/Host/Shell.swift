// Shell: the Mac app as a thin shell. Lumen (the command bar, its hot keys, its panel) is off unless VYRE_LUMEN=1; the app opens ONE window, the shared web
// app, on launch, on reopen and for "Open Vyre". The window is the no-local-vyred kind (the web build carried in this app) whenever no local vyred answers,
// and the web app's own first-run flow does the rest. The menu bar item is "Open Vyre" and "Quit Vyre". Pure, so the Swift tests run it.

import AppKit

public enum Shell {
    /// Lumen's one flag: off by default.
    public static func lumenEnabled(env: [String: String] = ProcessInfo.processInfo.environment) -> Bool { env["VYRE_LUMEN"] == "1" }

    /// A window with no local vyred to talk to carries the web build itself.
    public static func opensBoxless(vyredUp: Bool) -> Bool { !vyredUp }

    public static let menuTitles = ["Open Vyre", "Quit Vyre"]

    /// The brand background, the app's dark page colour (apps/app app.json). The window and the web view start on it, so nothing white shows while the page loads.
    public static let brandBackgroundHex = "#0E0D0C"
    public static var brandBackground: NSColor { NSColor(srgbRed: 14.0 / 255, green: 13.0 / 255, blue: 12.0 / 255, alpha: 1) }

    public enum Splash: Equatable {
        /// The shared splash piece (a self-contained HTML file, Contents/Resources/splash.html).
        case page(String)
        /// No piece in the app: the brand mark on the brand background.
        case brandMark
    }

    public static func splash(resources: String?) -> Splash {
        guard let r = resources else { return .brandMark }
        let p = r + "/splash.html"
        return FileManager.default.fileExists(atPath: p) ? .page(p) : .brandMark
    }

    /// How long to wait before the splash fades: nil until the page has loaded; then whatever is left of a short minimum, so a fast load is not a flicker.
    public static func fadeAfterMs(shownForMs: Int, loaded: Bool, minimumMs: Int = 900) -> Int? {
        guard loaded else { return nil }
        return max(0, minimumMs - shownForMs)
    }
}
