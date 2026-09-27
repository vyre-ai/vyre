// sight: what is on the Mac's screen, for Vyre, kept current by the notifications macOS sends.
//
// Asking the accessibility tree once a second would leave context up to a second stale and
// would cost CPU every second the Mac sits still. macOS already announces the transitions that
// matter (another app in front, another window, another focused control, a new title), so this
// helper subscribes to those and does nothing between them. A notification only marks the
// cached context dirty and records cheap facts; the context itself is read lazily, when vyred
// asks, and then cached until the next notification. Idle, there are no timers and no reads.
//
// Protocol: NDJSON over stdin and stdout, one request per line, never argv (argv is readable by
// every process through `ps`). The helper exits when stdin closes, so a vyred that dies takes it
// along.
//
//   {"id":1,"cmd":"trust"}                              is this process allowed to use AX
//   {"id":2,"cmd":"where"}                              front app, window title, URL (cheap)
//   {"id":3,"cmd":"context","text":true,"textMax":4000} the full context of the front app
//   {"id":4,"cmd":"watch","pid":n}                      also watch this pid (tests, a pinned app)
//   {"id":5,"cmd":"shotinfo","pid":n}                   Screen Recording grant and window ids
//   {"id":6,"cmd":"requestCapture"}                     ask macOS for Screen Recording (a dialog)
//
// "where" and "context" take "pid" to read one app instead of the front one. A test uses it to
// read the window it opened, never whatever the person is using.
//
// Unsolicited lines {"changed":{"app","bundle","pid","window"}} tell vyred its cache is stale.
// They are coalesced to at most one per 120 ms per app, and only the first change after a
// request gets a line: vyred drops its cache on it and has nothing more to learn until it asks.
//
// Redaction: when secure event input is on, or the focused control is a secure text field, the
// focused value and selection are never read and "secure":true is set. Secure fields are skipped
// in visible text. Nothing here writes to a log or a file.
//
// The Sight class takes its output function as a dependency so it can move into the native
// Capsule shell unchanged; the lines at the bottom run it standalone.

import Cocoa
import ApplicationServices
import Carbon

typealias JSON = [String: Any]

// ---------------------------------------------------------------- AX reads

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axElement(_ el: AXUIElement, _ name: String) -> AXUIElement? {
    guard let v = axAttr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

/// Several attributes in one inter-process round trip. Each single read is a synchronous message
/// to the other app, and the round trip is the cost, so a node's attributes are fetched together.
func axBatch(_ el: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
    var got: [String: CFTypeRef] = [:]
    var vals: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals)
    if err == .success, let arr = vals as? [CFTypeRef], arr.count == names.count {
        for (i, n) in names.enumerated() {
            let x = arr[i]
            // Unsupported attributes come back as an AXValue wrapping an error, or as CFNull.
            if CFGetTypeID(x) == AXValueGetTypeID(), AXValueGetType(x as! AXValue) == .axError { continue }
            if CFGetTypeID(x) == CFNullGetTypeID() { continue }
            got[n] = x
        }
    } else {
        for n in names { if let x = axAttr(el, n) { got[n] = x } }
    }
    return got
}

func sval(_ v: [String: CFTypeRef], _ k: String) -> String? {
    guard let x = v[k] else { return nil }
    if let s = x as? String { return s.isEmpty ? nil : s }
    if CFGetTypeID(x) == CFURLGetTypeID() { return (x as! URL).absoluteString }
    if let n = x as? NSNumber { return n.stringValue }
    return nil
}

func kids(_ v: [String: CFTypeRef]) -> [AXUIElement] {
    // A list or table publishes every row under AXChildren, which can be thousands; the visible
    // ones are what is on screen.
    if let vis = v["AXVisibleChildren"] as? [AXUIElement], !vis.isEmpty { return vis }
    return (v["AXChildren"] as? [AXUIElement]) ?? []
}

func frameOf(_ v: [String: CFTypeRef]) -> JSON? {
    guard let p = v["AXPosition"], let s = v["AXSize"],
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return ["x": Int(pt.x), "y": Int(pt.y), "w": Int(sz.width), "h": Int(sz.height)]
}

/// An app's name, or its executable's for a bare binary that has no bundle to name it.
func appName(_ ra: NSRunningApplication?, _ pid: pid_t) -> Any {
    if let n = ra?.localizedName ?? ra?.executableURL?.lastPathComponent { return n }
    var buf = [CChar](repeating: 0, count: 256)
    return proc_name(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : NSNull()
}

func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) : s }

func isSecure(role: String?, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

/// The window a person is looking at in an app. An app that is not active (a test window that
/// opened without taking focus) may have no focused window, so fall back to its main window and
/// then its first one.
func windowOf(_ app: AXUIElement) -> AXUIElement? {
    if let w = axElement(app, kAXFocusedWindowAttribute as String) { return w }
    if let w = axElement(app, kAXMainWindowAttribute as String) { return w }
    if let ws = axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement], let w = ws.first { return w }
    return nil
}

let BROWSERS: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
    "org.chromium.Chromium", "com.apple.Safari", "com.apple.SafariTechnologyPreview",
    "company.thebrowser.Browser", "company.thebrowser.dia", "com.microsoft.edgemac", "com.brave.Browser",
    "org.mozilla.firefox", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]

let NOTES: [String] = [
    kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification, kAXTitleChangedNotification,
    kAXSelectedTextChangedNotification, kAXWindowCreatedNotification, kAXWindowMovedNotification,
    kAXWindowResizedNotification, kAXWindowMiniaturizedNotification, kAXApplicationActivatedNotification,
]

// ---------------------------------------------------------------- one watched app

final class AppWatch {
    let pid: pid_t
    let app: AXUIElement
    weak var owner: Sight?
    var observer: AXObserver?
    /// The focused control, the only element whose value changes are followed: subscribing to
    /// value changes app-wide would wake this process for every character any field redraws.
    var focused: AXUIElement?
    var front = false, pinned = false
    /// Whether vyred has asked since the last change line. Until it asks again, a change needs
    /// no line: vyred already knows its cache is stale.
    var armed = true
    /// Whether the AX notifications are registered. They are dropped after a change line and
    /// registered again on the next request (see Sight.unsubscribe).
    var subscribed = false
    var refocus = true
    var flushPending = false
    var cache: [String: (at: Double, body: JSON)] = [:]

    init(pid: pid_t) { self.pid = pid; self.app = AXUIElementCreateApplication(pid) }
}

let axCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon = refcon else { return }
    let w = Unmanaged<AppWatch>.fromOpaque(refcon).takeUnretainedValue()
    w.owner?.noted(w, notification as String)
}

// ---------------------------------------------------------------- the component

final class Sight {
    private let out: (JSON) -> Void
    private var watches: [pid_t: AppWatch] = [:]
    private var frontPid: pid_t = 0
    private var started = false
    private var enhanced: Set<pid_t> = []
    private let now: () -> Double

    init(out: @escaping (JSON) -> Void, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.out = out
        self.now = now
    }

    /// Subscribe to app switches and attach to the front app. Without the Accessibility grant
    /// there is nothing to attach to, so this runs again on the first request after a grant.
    func start() {
        guard !started, AXIsProcessTrusted() else { return }
        started = true
        // A stuck app must cost one slow read, not wedge the helper that every call waits on.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let a = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.front(a.processIdentifier)
        }
        nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let a = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let w = self?.watches[a.processIdentifier] else { return }
            self?.release(w)
        }
        if let a = NSWorkspace.shared.frontmostApplication { front(a.processIdentifier) }
    }

    private func front(_ pid: pid_t) {
        if pid == frontPid { return }
        if let old = watches[frontPid] { old.front = false; if !old.pinned { release(old) } }
        frontPid = pid
        guard let w = watch(pid) else { return }
        w.front = true
        noted(w, kAXApplicationActivatedNotification)
    }

    private func watch(_ pid: pid_t) -> AppWatch? {
        if let w = watches[pid] { return w }
        let w = AppWatch(pid: pid)
        w.owner = self
        // Chromium and Electron publish no tree, and send no notifications, until an assistive
        // client asks for them.
        AXUIElementSetAttributeValue(w.app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var obs: AXObserver?
        guard AXObserverCreate(pid, axCallback, &obs) == .success, let o = obs else { return nil }
        w.observer = o
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
        watches[pid] = w
        subscribe(w)
        return w
    }

    private func release(_ w: AppWatch) {
        unsubscribe(w)
        if let o = w.observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
        w.observer = nil
        w.owner = nil
        watches[w.pid] = nil
        enhanced.remove(w.pid)
    }

    private func subscribe(_ w: AppWatch) {
        guard let o = w.observer, !w.subscribed else { return }
        w.subscribed = true
        let me = Unmanaged.passUnretained(w).toOpaque()
        for n in NOTES { AXObserverAddNotification(o, w.app, n as CFString, me) }
        follow(w)
    }

    /// Stop listening to an app whose cache is already stale. A busy window (a terminal printing
    /// output with a spinner in its title) sends ten or more notifications a second, and each
    /// one wakes this process for nothing until vyred asks again.
    private func unsubscribe(_ w: AppWatch) {
        guard let o = w.observer, w.subscribed else { return }
        w.subscribed = false
        for n in NOTES { AXObserverRemoveNotification(o, w.app, n as CFString) }
        if let f = w.focused { AXObserverRemoveNotification(o, f, kAXValueChangedNotification as CFString) }
        w.focused = nil
        w.refocus = true
    }

    /// Move the value-change subscription to the control that now has focus.
    private func follow(_ w: AppWatch) {
        w.refocus = false
        guard let o = w.observer, w.subscribed else { return }
        if let f = w.focused { AXObserverRemoveNotification(o, f, kAXValueChangedNotification as CFString) }
        w.focused = axElement(w.app, kAXFocusedUIElementAttribute as String)
        if let f = w.focused {
            AXObserverAddNotification(o, f, kAXValueChangedNotification as CFString, Unmanaged.passUnretained(w).toOpaque())
        }
    }

    /// A notification: mark the cache stale and, at most once per 120 ms, say so. Only the first
    /// change after a request is worth a line: vyred drops its whole cache on it, so until vyred
    /// asks again there is nothing new to tell it, and the app is not listened to meanwhile.
    func noted(_ w: AppWatch, _ name: String) {
        w.cache.removeAll()
        if name == kAXFocusedUIElementChangedNotification { w.refocus = true }
        guard w.armed, !w.flushPending else { return }
        w.flushPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self, weak w] in
            guard let self = self, let w = w, self.watches[w.pid] === w else { return }
            self.flush(w)
        }
    }

    private func flush(_ w: AppWatch) {
        w.flushPending = false
        guard w.armed else { return }
        w.armed = false
        out(["changed": facts(w)])
        unsubscribe(w)
    }

    /// A request for this app: listen again, so the next change clears what this request caches.
    private func arm(_ w: AppWatch) {
        w.armed = true
        subscribe(w)
        if w.refocus { follow(w) }
    }

    private func facts(_ w: AppWatch) -> JSON {
        let ra = NSRunningApplication(processIdentifier: w.pid)
        var title: Any = NSNull()
        if let win = windowOf(w.app), let t = axAttr(win, kAXTitleAttribute as String) as? String { title = t }
        return ["pid": Int(w.pid), "app": appName(ra, w.pid), "bundle": ra?.bundleIdentifier ?? NSNull(), "window": title]
    }

    // ------------------------------------------------------------ requests

    func handle(_ req: JSON) -> JSON {
        let cmd = req["cmd"] as? String ?? ""
        if cmd == "trust" {
            // Plain AXIsProcessTrusted, never the prompting form: a system dialog is the
            // person's decision, not a helper's.
            return ["trusted": AXIsProcessTrusted(), "pid": Int(ProcessInfo.processInfo.processIdentifier)]
        }
        if cmd == "requestCapture" {
            return ["granted": CGRequestScreenCaptureAccess()]
        }
        // Without the grant every AX read fails in a way that looks like an app with no windows.
        guard AXIsProcessTrusted() else { return ["error": "this process is not allowed to use the accessibility API", "code": "not_trusted"] }
        start()
        let asked = (req["pid"] as? NSNumber).map { pid_t($0.int32Value) }
        switch cmd {
        case "watch":
            guard let p = asked, let w = watch(p) else { return ["error": "no such app to watch", "code": "no_app"] }
            w.pinned = true
            arm(w)
            return ["watching": Int(p)]
        case "unwatch":
            if let p = asked, let w = watches[p] { w.pinned = false; if !w.front { release(w) } }
            return ["watching": NSNull()]
        case "shotinfo":
            return shotInfo(asked ?? frontPid)
        case "where", "context":
            let pid = asked ?? (frontPid != 0 ? frontPid : (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0))
            guard pid > 0 else { return ["error": "no app is in front", "code": "no_app"] }
            let text = cmd == "context" && (req["text"] as? Bool ?? true)
            let textMax = max(0, min((req["textMax"] as? NSNumber)?.intValue ?? 4000, 20000))
            let maxAge = (req["maxAgeMs"] as? NSNumber)?.doubleValue ?? .infinity
            let key = "\(cmd)|\(text)|\(textMax)"
            let w = watches[pid]
            if let w = w { arm(w) }
            if let c = w?.cache[key], now() - c.at <= maxAge {
                var b = c.body; b["cached"] = true; return b
            }
            let t0 = now()
            var body = cmd == "where" ? whereOf(pid) : contextOf(pid, text: text, textMax: textMax)
            body["at"] = Int(t0)
            body["ms"] = Int((now() - t0).rounded())
            w?.cache[key] = (t0, body)
            body["cached"] = false
            return body
        default:
            return ["error": "unknown command", "code": "bad_request"]
        }
    }

    private func appInfo(_ pid: pid_t) -> JSON {
        let ra = NSRunningApplication(processIdentifier: pid)
        return ["name": appName(ra, pid), "bundle": ra?.bundleIdentifier ?? NSNull(), "pid": Int(pid)]
    }

    private func whereOf(_ pid: pid_t) -> JSON {
        let app = AXUIElementCreateApplication(pid)
        let info = appInfo(pid)
        var body: JSON = ["app": info, "window": NSNull(), "url": NSNull()]
        guard let win = windowOf(app) else { return body }
        let v = axBatch(win, ["AXTitle", "AXPosition", "AXSize", "AXDocument"])
        body["window"] = ["title": sval(v, "AXTitle") ?? NSNull(), "frame": frameOf(v) ?? NSNull()] as JSON
        body["url"] = urlOf(win, bundle: info["bundle"] as? String, document: sval(v, "AXDocument")) ?? NSNull()
        return body
    }

    /// The page a browser shows: AXURL on the window's web area, found by a short bounded walk.
    /// Firefox exposes it only sometimes. Other apps may name their document with AXDocument.
    private func urlOf(_ win: AXUIElement, bundle: String?, document: String?) -> String? {
        guard let b = bundle, BROWSERS.contains(b) else { return document }
        let deadline = now() + 80
        var queue: [AXUIElement] = [win]
        var seen = 0
        while !queue.isEmpty && seen < 600 && now() < deadline {
            let el = queue.removeFirst()
            seen += 1
            let v = axBatch(el, ["AXRole", "AXURL", "AXChildren"])
            if sval(v, "AXRole") == "AXWebArea", let u = sval(v, "AXURL") { return u }
            queue.append(contentsOf: (v["AXChildren"] as? [AXUIElement]) ?? [])
        }
        return document
    }

    private func contextOf(_ pid: pid_t, text: Bool, textMax: Int) -> JSON {
        var body = whereOf(pid)
        let app = AXUIElementCreateApplication(pid)
        if text && !enhanced.contains(pid) {
            enhanced.insert(pid)
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        var secure = IsSecureEventInputEnabled()
        body["focused"] = NSNull()
        if let f = axElement(app, kAXFocusedUIElementAttribute as String) {
            // Role first, and the value only once the control is known not to be secure, so a
            // password is never read into this process at all.
            let v = axBatch(f, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXPlaceholderValue", "AXPosition", "AXSize"])
            let role = sval(v, "AXRole"), sub = sval(v, "AXSubrole")
            if isSecure(role: role, subrole: sub) { secure = true }
            var fo: JSON = ["role": role ?? NSNull(), "subrole": sub ?? NSNull(),
                            "name": (sval(v, "AXTitle") ?? sval(v, "AXDescription") ?? sval(v, "AXPlaceholderValue")) as Any? ?? NSNull(),
                            "frame": frameOf(v) ?? NSNull()]
            if !secure {
                let vv = axBatch(f, ["AXValue", "AXSelectedText"])
                fo["value"] = sval(vv, "AXValue").map { clip($0, 2000) } ?? NSNull()
                fo["selectedText"] = sval(vv, "AXSelectedText").map { clip($0, 2000) } ?? NSNull()
            }
            body["focused"] = fo
        }
        body["secure"] = secure
        if text, let win = windowOf(app) {
            let (t, cut) = visibleText(win, max: textMax)
            body["text"] = t
            body["truncated"] = cut
        } else {
            body["text"] = NSNull()
            body["truncated"] = false
        }
        return body
    }

    /// The words in a window in reading order: a depth-first walk collecting static text and the
    /// values of ordinary text fields, bounded by a deadline, a node cap and a character cap.
    private func visibleText(_ win: AXUIElement, max: Int) -> (String, Bool) {
        let deadline = now() + 150
        var stack: [AXUIElement] = [win]
        var nodes = 0, chars = 0
        var parts: [String] = []
        var cut = false
        let names = ["AXRole", "AXSubrole", "AXValue", "AXTitle", "AXChildren", "AXVisibleChildren"]
        while let el = stack.popLast() {
            if nodes >= 3000 || now() > deadline || chars >= max { cut = true; break }
            nodes += 1
            let v = axBatch(el, names)
            let role = sval(v, "AXRole"), sub = sval(v, "AXSubrole")
            if isSecure(role: role, subrole: sub) { continue }
            var s: String?
            switch role {
            case "AXStaticText": s = sval(v, "AXValue") ?? sval(v, "AXTitle")
            case "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField": s = sval(v, "AXValue")
            default: break
            }
            if let raw = s?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, raw != parts.last {
                let room = max - chars
                let piece = clip(raw, room)
                if piece.count < raw.count { cut = true }
                parts.append(piece)
                chars += piece.count + 1
            }
            // A static text's children are its own glyph runs; the words are already taken.
            if role == "AXStaticText" { continue }
            stack.append(contentsOf: kids(v).reversed())
        }
        if !stack.isEmpty { cut = true }
        return (parts.joined(separator: "\n"), cut)
    }

    /// What a screenshot needs to know: whether Screen Recording is granted (checked, never
    /// requested) and the on-screen windows front to back, so the caller can refuse a blind place.
    private func shotInfo(_ pid: pid_t) -> JSON {
        let granted = CGPreflightScreenCaptureAccess()
        var windows: [JSON] = []
        var windowId: Any = NSNull()
        if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for w in list {
                guard (w[kCGWindowLayer as String] as? Int) == 0, let owner = w[kCGWindowOwnerPID as String] as? Int else { continue }
                let id = w[kCGWindowNumber as String] as? Int ?? 0
                if owner == Int(pid) && windowId is NSNull { windowId = id }
                let ra = NSRunningApplication(processIdentifier: pid_t(owner))
                windows.append(["pid": owner, "id": id, "bundle": ra?.bundleIdentifier ?? NSNull(),
                                "app": ra?.localizedName ?? NSNull(), "title": w[kCGWindowName as String] as? String ?? NSNull()])
            }
        }
        return ["granted": granted, "pid": Int(pid), "windowId": windowId, "windows": windows]
    }
}

// ---------------------------------------------------------------- standalone

signal(SIGPIPE, SIG_IGN)

func writeLine(_ obj: JSON) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write(Data([0x0a]))
}

let sight = Sight(out: writeLine)
sight.start()

// Requests are read on a thread of their own (a blocking read costs nothing while idle) and
// handled on the main thread, where the AX observers deliver, so the two never race.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty else { continue }
        DispatchQueue.main.async {
            guard let d = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: d)) as? JSON else {
                writeLine(["error": "a request must be one JSON object per line", "code": "bad_request"])
                return
            }
            var res = sight.handle(req)
            res["id"] = req["id"] ?? NSNull()
            writeLine(res)
        }
    }
    DispatchQueue.main.async { exit(0) }
}

CFRunLoopRun()
