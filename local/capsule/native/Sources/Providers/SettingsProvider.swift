// SettingsProvider: System Settings panes by name or by what people call them ("wifi", "volume",
// "dark mode"), opened by their x-apple.systempreferences: URL. The table is local.js PANES.
//
// Every bundle id below (and every Privacy_* anchor) was read on Darwin 25 from
// /System/Library/ExtensionKit/Extensions/*.appex/Contents/Info.plist with `plutil -extract
// CFBundleIdentifier` (General from System Settings.app's own PlugIns), and the anchors from the
// SecurityPrivacyExtension bundle. The one unverified piece is the "?Shortcuts" anchor on
// Keyboard: it is widely used but not listed in the bundle; without it the Keyboard pane still
// opens.
//
// Icons: a pane's real icon is its .appex bundle's icon, found by reading the CFBundleIdentifier
// of each extension System Settings loads (swift/local.swift paneBundles). That read happens once,
// off the main thread, on the first warm(); until it lands, and for a pane with no bundle found,
// the row carries the SF Symbol from the table.

import Foundation

public struct SettingsPane: Sendable, Equatable {
    public var label: String
    public var pane: String
    public var synonyms: [String]
    public var symbol: String
}

public final class SettingsProvider: ResultProvider, @unchecked Sendable {
    public let id = "settings"
    public let speed = Speed.quick
    public var limit = 4
    static let PRIV = "com.apple.settings.PrivacySecurity.extension"
    public static let SETTINGS_APP = "/System/Applications/System Settings.app"

    public static let PANES: [SettingsPane] = [
        .init(label: "Wi-Fi", pane: "com.apple.wifi-settings-extension", synonyms: ["wifi", "wireless", "internet", "wlan", "hotspot"], symbol: "wifi"),
        .init(label: "Bluetooth", pane: "com.apple.BluetoothSettings", synonyms: ["airpods", "headphones", "pair"], symbol: "dot.radiowaves.left.and.right"),
        .init(label: "Network", pane: "com.apple.Network-Settings.extension", synonyms: ["internet", "ethernet", "dns", "proxy", "ip address", "firewall"], symbol: "network"),
        .init(label: "VPN", pane: "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension", synonyms: ["tunnel"], symbol: "lock.shield"),
        .init(label: "Displays", pane: "com.apple.Displays-Settings.extension", synonyms: ["monitor", "screen", "resolution", "brightness", "night shift", "external display"], symbol: "display"),
        .init(label: "Sound", pane: "com.apple.Sound-Settings.extension", synonyms: ["volume", "audio", "speakers", "microphone", "output", "input", "alert sound"], symbol: "speaker.wave.2"),
        .init(label: "Notifications", pane: "com.apple.Notifications-Settings.extension", synonyms: ["alerts", "banners"], symbol: "bell.badge"),
        .init(label: "Focus", pane: "com.apple.Focus-Settings.extension", synonyms: ["do not disturb", "dnd"], symbol: "moon"),
        .init(label: "Battery", pane: "com.apple.Battery-Settings.extension", synonyms: ["power", "energy", "low power mode", "charging"], symbol: "battery.75percent"),
        .init(label: "Keyboard", pane: "com.apple.Keyboard-Settings.extension", synonyms: ["typing", "key repeat", "input sources", "dictation", "language"], symbol: "keyboard"),
        .init(label: "Keyboard Shortcuts", pane: "com.apple.Keyboard-Settings.extension?Shortcuts", synonyms: ["hotkeys", "shortcuts"], symbol: "command"),
        .init(label: "Trackpad", pane: "com.apple.Trackpad-Settings.extension", synonyms: ["gestures", "tap to click", "scroll direction"], symbol: "rectangle.and.hand.point.up.left"),
        .init(label: "Mouse", pane: "com.apple.Mouse-Settings.extension", synonyms: ["pointer speed", "scroll direction"], symbol: "computermouse"),
        .init(label: "Accessibility", pane: "com.apple.Accessibility-Settings.extension", synonyms: ["voiceover", "zoom", "reduce motion", "larger text"], symbol: "accessibility"),
        .init(label: "Privacy & Security", pane: PRIV, synonyms: ["privacy", "security", "permissions", "filevault", "gatekeeper"], symbol: "hand.raised"),
        .init(label: "Accessibility Permissions", pane: "\(PRIV)?Privacy_Accessibility", synonyms: ["allow app control", "privacy accessibility"], symbol: "accessibility"),
        .init(label: "Input Monitoring", pane: "\(PRIV)?Privacy_ListenEvent", synonyms: ["keylogging", "keyboard access", "hotkey permission"], symbol: "keyboard.badge.eye"),
        .init(label: "Screen Recording", pane: "\(PRIV)?Privacy_ScreenCapture", synonyms: ["screen capture", "screen sharing permission"], symbol: "rectangle.dashed.badge.record"),
        .init(label: "Full Disk Access", pane: "\(PRIV)?Privacy_AllFiles", synonyms: ["disk access", "fda", "all files"], symbol: "internaldrive"),
        .init(label: "Contacts Access", pane: "\(PRIV)?Privacy_Contacts", synonyms: ["contacts permission", "address book"], symbol: "person.crop.circle"),
        .init(label: "Camera Access", pane: "\(PRIV)?Privacy_Camera", synonyms: ["camera", "webcam"], symbol: "camera"),
        .init(label: "Microphone Access", pane: "\(PRIV)?Privacy_Microphone", synonyms: ["microphone", "mic"], symbol: "mic"),
        .init(label: "Location Services", pane: "\(PRIV)?Privacy_LocationServices", synonyms: ["location", "gps"], symbol: "location"),
        .init(label: "Automation", pane: "\(PRIV)?Privacy_Automation", synonyms: ["apple events", "applescript"], symbol: "gearshape.2"),
        .init(label: "General", pane: "com.apple.systempreferences.GeneralSettings", synonyms: ["about", "about this mac"], symbol: "gear"),
        .init(label: "Software Update", pane: "com.apple.Software-Update-Settings.extension", synonyms: ["update", "upgrade", "macos update"], symbol: "arrow.triangle.2.circlepath"),
        .init(label: "Storage", pane: "com.apple.settings.Storage", synonyms: ["disk space", "free space"], symbol: "externaldrive"),
        .init(label: "Date & Time", pane: "com.apple.Date-Time-Settings.extension", synonyms: ["clock", "time zone", "timezone"], symbol: "clock"),
        .init(label: "Sharing", pane: "com.apple.Sharing-Settings.extension", synonyms: ["file sharing", "screen sharing", "remote login", "ssh", "computer name", "airplay receiver"], symbol: "square.and.arrow.up"),
        .init(label: "Login Items", pane: "com.apple.LoginItems-Settings.extension", synonyms: ["startup items", "launch at login", "background items"], symbol: "power"),
        .init(label: "Users & Groups", pane: "com.apple.Users-Groups-Settings.extension", synonyms: ["accounts", "users", "guest"], symbol: "person.2"),
        .init(label: "Touch ID & Password", pane: "com.apple.Touch-ID-Settings.extension", synonyms: ["password", "fingerprint", "login password"], symbol: "touchid"),
        .init(label: "Lock Screen", pane: "com.apple.Lock-Screen-Settings.extension", synonyms: ["screen saver timeout", "require password"], symbol: "lock"),
        .init(label: "Wallpaper", pane: "com.apple.Wallpaper-Settings.extension", synonyms: ["background", "desktop picture"], symbol: "photo"),
        .init(label: "Appearance", pane: "com.apple.Appearance-Settings.extension", synonyms: ["dark mode", "light mode", "accent color", "theme"], symbol: "circle.lefthalf.filled"),
        .init(label: "Desktop & Dock", pane: "com.apple.Desktop-Settings.extension", synonyms: ["dock", "mission control", "hot corners", "stage manager", "windows"], symbol: "dock.rectangle"),
        .init(label: "Control Center", pane: "com.apple.ControlCenter-Settings.extension", synonyms: ["menu bar", "control centre"], symbol: "switch.2"),
        .init(label: "Siri", pane: "com.apple.Siri-Settings.extension", synonyms: ["voice assistant", "hey siri"], symbol: "waveform"),
        .init(label: "Spotlight", pane: "com.apple.Spotlight-Settings.extension", synonyms: ["search"], symbol: "magnifyingglass"),
        .init(label: "Printers & Scanners", pane: "com.apple.Print-Scan-Settings.extension", synonyms: ["printer", "print", "scanner"], symbol: "printer"),
        .init(label: "Time Machine", pane: "com.apple.Time-Machine-Settings.extension", synonyms: ["backup"], symbol: "clock.arrow.circlepath"),
        .init(label: "Screen Time", pane: "com.apple.Screen-Time-Settings.extension", synonyms: ["parental controls", "app limits"], symbol: "hourglass"),
        .init(label: "Internet Accounts", pane: "com.apple.Internet-Accounts-Settings.extension", synonyms: ["email accounts", "mail accounts", "google account"], symbol: "at"),
        .init(label: "Language & Region", pane: "com.apple.Localization-Settings.extension", synonyms: ["language", "region", "locale"], symbol: "globe"),
    ]

    let bundleDirs: [String]
    private let lock = NSLock()
    private var bundles: [String: String]?
    private var reading = false

    public init(bundleDirs: [String] = ["/System/Library/ExtensionKit/Extensions", SettingsProvider.SETTINGS_APP + "/Contents/PlugIns",
                                        SettingsProvider.SETTINGS_APP + "/Contents/Extensions"]) {
        self.bundleDirs = bundleDirs
    }

    /// Read the pane bundles once, off the main thread.
    public func warm() {
        let go: Bool = lock.withLock { if bundles != nil || reading { return false }; reading = true; return true }
        guard go else { return }
        DispatchQueue.global(qos: .utility).async { [self] in
            let map = Self.readBundles(bundleDirs)
            lock.withLock { bundles = map; reading = false }
        }
    }

    /// The map is a few dozen short strings; kept.
    public func cool() {}

    /// Settings extension id -> its .appex path.
    public static func readBundles(_ dirs: [String]) -> [String: String] {
        var map: [String: String] = [:]
        for dir in dirs {
            for n in ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).sorted() where n.hasSuffix(".appex") {
                let p = dir + "/" + n
                if let info = NSDictionary(contentsOfFile: p + "/Contents/Info.plist"), let id = info["CFBundleIdentifier"] as? String, map[id] == nil {
                    map[id] = p
                }
            }
        }
        return map
    }

    /// The bundle id part of a pane: "com.apple.X?Anchor" -> "com.apple.X".
    public static func paneID(_ pane: String) -> String { pane.split(separator: "?", maxSplits: 1).first.map(String.init) ?? pane }

    /// The icon for a pane: its bundle's icon when known, else the table's symbol.
    public func icon(_ p: SettingsPane) -> IconSpec {
        if let path = lock.withLock({ bundles?[Self.paneID(p.pane)] }) { return .file(path) }
        return .symbol(p.symbol, .stone)
    }

    public func results(for query: Query) async -> [ResultItem] { search(query.text) }

    public func search(_ text: String) -> [ResultItem] {
        var hits: [(SettingsPane, Double)] = []
        for p in Self.PANES {
            let s = Match.score(text, p.label, synonyms: p.synonyms)
            if s > 0 { hits.append((p, s)) }
        }
        hits.sort { a, b in a.1 != b.1 ? a.1 > b.1 : a.0.label.count != b.0.label.count ? a.0.label.count < b.0.label.count : a.0.label < b.0.label }
        return hits.prefix(limit).map { p, s in
            let pane = p.pane
            return ResultItem(id: "setting:" + pane, kind: "setting", title: p.label, subtitle: "System Settings", icon: icon(p),
                              section: .settings, score: s, actions: [
                                ResultAction(id: "open", title: "Open", symbol: "gear", shortcut: KeyShortcut("return")) { _, _ in
                                    await Launch.openSetting(pane)
                                },
                              ], copyText: Launch.settingsScheme + ":" + pane, payload: ["url": Launch.settingsScheme + ":" + pane])
        }
    }
}
