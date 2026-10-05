// FirstRun: the Mac app's first run, as a decision. The Capsule is a menu-bar app whose one window needs a local vyred, so a Mac with no vyred and no
// server had nowhere to begin. Now the first thing it shows is "Where should Vyre run?": on this Mac (the bundled setup, then the app window) or on a
// server (the app window with no local vyred: its page pairs to the server by typed code over the relay, as a browser does).
//
// This file is the pure part, so the Swift tests can run it: what the person chose is kept in <home>/capsule/first-run.json, and `decide` says what
// a launch does given that and whether vyred answered. The window is FirstRunWindow.swift. A Mac that already runs vyred and never chose anything
// (an install from before this window) is left as it was: the menu-bar app, no window.

import Foundation

public enum FirstRunChoice: String, Equatable {
    /// vyred runs on this Mac.
    case here
    /// vyred runs on a server; this Mac's app window is a client of it.
    case server
}

public enum FirstRunStart: Equatable {
    /// Nothing to show: a Mac that already runs vyred, from before the first run existed.
    case nothing
    /// Asks where Vyre should run. No launch gives this any more (a Mac with no vyred opens the app window as a client); kept for a window that asks on purpose.
    case askWhere
    /// Chose this Mac, and vyred is not running (restarted, or setup was left half done): start it, then open the app.
    case startHere
    /// Open the app window; `boxless` is a server Mac, whose window carries the web export itself and talks to the server over the relay.
    case openApp(boxless: Bool)
}

public struct FirstRunStore {
    public let file: String

    public init(home: String) { file = (home as NSString).appendingPathComponent("capsule/first-run.json") }

    /// What the person chose, or nil when they have not (or the file is not ours).
    public func load() -> FirstRunChoice? {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: file)),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let c = o["choice"] as? String else { return nil }
        return FirstRunChoice(rawValue: c)
    }

    public func save(_ choice: FirstRunChoice) {
        try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        guard let d = try? JSONSerialization.data(withJSONObject: ["choice": choice.rawValue]) else { return }
        try? d.write(to: URL(fileURLWithPath: file), options: .atomic)
    }

    /// Ask again at the next launch.
    public func forget() { try? FileManager.default.removeItem(atPath: file) }
}

public enum FirstRun {
    /// What a launch does. `vyredUp` is what the first look at /v1/health said.
    public static func decide(vyredUp: Bool, remembered: FirstRunChoice?) -> FirstRunStart {
        switch remembered {
        case .server?: return .openApp(boxless: true)
        case .here?: return vyredUp ? .openApp(boxless: false) : .startHere
        // No choice and no vyred: this Mac is a client (the page asks setup's one question: joining a team, or setting up My Cloud on the person's own server). Making this Mac a server is an
        // explicit choice later, in Settings, never automatic (`FirstRunController.makeThisMacServer`).
        case nil: return vyredUp ? .nothing : .openApp(boxless: true)
        }
    }
}

/// The window's words (ui-ux, setup-prototype.html, the Mac column, rows 4 to 4d). Pure, so the tests hold them.
public enum FirstRunWords {
    public static let title = "Where should Vyre run?"
    public static let line = "Vyre runs on a computer that stays on. Your phone and browser connect to it."
    public static let hereTitle = "On this Mac"
    public static let hereLine = "Vyre runs here, while this Mac is on."
    public static let serverTitle = "On a server"
    public static let serverLine = "Vyre runs on another computer that stays on. You type a code to connect."

    public static let serverStepTitle = "Run this on your server"
    public static let serverStepLine = "Open the server's terminal and paste the line. It shows a code when it is ready."
    /// The one line a server runs for a stable release (what vyre.run/i serves).
    public static let stableInstallLine = "curl -fsSL vyre.run/i | sh"

    /// The line for this app's version. A release candidate (a hyphen in the version, such as 0.3.0-rc.1) is not on vyre.run/i, so its line comes from that
    /// release's own files; a stable version, or a version that is not plain version characters, gets the stable line.
    public static func installLine(version: String?) -> String {
        guard let v = version, v.contains("-"), v.range(of: "^[0-9A-Za-z][0-9A-Za-z.+-]*$", options: .regularExpression) != nil else { return stableInstallLine }
        let base = "https://github.com/vyre-ai/vyre/releases/download/v\(v)"
        return "curl -fsSL \(base)/install-box.sh | VYRE_BOX_URL=\(base)/ sh"
    }
    public static let copyLine = "Copy the line"
    public static let serverShowsCode = "My server shows a code"

    public static let settingTitle = "Setting up Vyre on this Mac"
    public static let settingLine = "This takes about a minute."
    public static let settingSteps = ["Getting Vyre", "Starting Vyre on this Mac", "Getting your space ready"]
    public static let passwordNote = "Your Mac asks for its password once. Vyre needs it so it can start by itself when you log in."

    public struct Failure: Equatable { public let title: String; public let body: String }

    /// What went wrong, in the words of rows 4d: the Mac password not entered, no internet, or anything else. `said` is what the setup said last (may be nil).
    public static func failure(_ said: String?) -> Failure {
        let m = (said ?? "").lowercased()
        if m.contains("password") || m.contains("cancel") || m.contains("authoriz") || m.contains("askpass") || m.contains("not permitted") {
            return Failure(title: "Vyre did not start", body: "The Mac password was not entered, so nothing was set up. Nothing was changed.")
        }
        if m.contains("download") || m.contains("network") || m.contains("internet") || m.contains("resolve") || m.contains("curl") || m.contains("connect") || m.contains("offline") {
            return Failure(title: "Vyre could not finish setting up", body: "It could not get what it needs. Check your internet, then try again. Nothing was changed.")
        }
        return Failure(title: "Vyre could not finish setting up", body: "Setting up did not finish. Nothing was changed.")
    }
}
