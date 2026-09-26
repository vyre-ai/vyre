// ax — the accessibility helper behind Vyre's hands on macOS.
//
// One request in, one JSON answer out. The request arrives as a JSON object on stdin rather
// than in argv, because argv is readable by every process on the machine through `ps`, and a
// request to type text may carry something the user would not want listed there.
//
// Why a compiled helper rather than osascript:
//   1. System Events returns ZERO windows for Chromium and Electron apps. Those apps publish an
//      accessibility tree only after an assistive client sets AXManualAccessibility on them,
//      which System Events never does. That is a large share of the apps people work in.
//   2. Every osascript call pays about 200ms of interpreter startup. This answers in
//      single-digit milliseconds plus whatever the target app takes to reply.
//   3. JXA's CoreFoundation bridge cannot index a CFArray of AXUIElement at all, so the tree
//      could never be walked from JXA in the first place.
//
// Commands (the "cmd" key):
//   trust   is this process allowed to use the accessibility API
//   snap    the elements of an app's windows, bounded, with enough identity to find them again
//   act     one action on the element at a path, after checking it is still the element meant
//
// This helper never asks macOS to show the permission prompt and never changes a setting. It
// reports "not_trusted" and lets the caller tell the person what to grant.

import Cocoa
import ApplicationServices

// ---------------------------------------------------------------- plumbing

func emit(_ obj: Any) {
    let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// Errors are JSON on stdout too, with a machine-readable code, so the caller never has to
/// parse English to decide what went wrong.
func fail(_ code: String, _ msg: String) -> Never {
    emit(["error": msg, "code": code])
    exit(2)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute as String) ?? "?" }

func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

// ---------------------------------------------------------------- request

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else {
    fail("bad_request", "the request must be a JSON object on stdin")
}
let cmd = req["cmd"] as? String ?? ""

func int(_ k: String, _ dflt: Int, max: Int) -> Int {
    let n = (req[k] as? NSNumber)?.intValue ?? dflt
    return Swift.max(1, Swift.min(n, max))
}

if cmd == "trust" {
    // Plain AXIsProcessTrusted, never the WithOptions form with the prompt: showing a system
    // dialog is a decision for the person, not for a helper that was asked a question.
    emit(["trusted": AXIsProcessTrusted(), "pid": ProcessInfo.processInfo.processIdentifier])
    exit(0)
}

// Everything below reads other apps. Without the grant, every AX call fails with a generic
// error that looks like an app with no windows, which would be a lie about the app.
if !AXIsProcessTrusted() {
    fail("not_trusted", "this process is not allowed to use the accessibility API")
}

// ---------------------------------------------------------------- batched reads

/// Everything one node publishes, fetched in a SINGLE inter-process round trip.
///
/// Every AXUIElementCopyAttributeValue is a synchronous message to the target app, answered one
/// at a time. Profiled on a folder window, a 300-control snapshot spent 2412ms of its 2433ms
/// inside those calls, about 29 per node. AXUIElementCopyMultipleAttributeValues asks for the
/// whole set in one message: 1975ms one at a time against 136ms batched for the same 400
/// elements. The round trip is the cost and the payload is nearly free, so the batch asks for
/// everything a snapshot could want rather than guessing which kind of app is in front.
let SNAP_ATTRS: [String] = [
    "AXRole", "AXTitle", "AXDescription", "AXValue", "AXHelp", "AXPlaceholderValue", "AXLabel",
    "AXIdentifier", "AXRoleDescription", "AXSubrole", "AXDOMIdentifier",
    "AXPosition", "AXSize", "AXEnabled", "AXFocused", "AXChildren",
]

struct Props {
    let el: AXUIElement
    private let v: [String: CFTypeRef]

    init(_ el: AXUIElement) {
        self.el = el
        var got: [String: CFTypeRef] = [:]
        var vals: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(
            el, SNAP_ATTRS as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals)
        if err == .success, let arr = vals as? [CFTypeRef], arr.count == SNAP_ATTRS.count {
            for (i, n) in SNAP_ATTRS.enumerated() {
                let x = arr[i]
                // An unsupported attribute comes back as an AXValue wrapping an error, and CFNull
                // stands in for nil. Both must be dropped or every node looks like it published
                // everything.
                if CFGetTypeID(x) == AXValueGetTypeID(), AXValueGetType(x as! AXValue) == .axError { continue }
                if CFGetTypeID(x) == CFNullGetTypeID() { continue }
                got[n] = x
            }
        } else {
            // An app that will not answer the batched form still has to be walked. Slow is
            // acceptable; reporting a nameless screen because of it would be wrong.
            for n in SNAP_ATTRS { if let x = attr(el, n) { got[n] = x } }
        }
        self.v = got
    }

    func str(_ name: String) -> String? {
        guard let x = v[name] else { return nil }
        if let s = x as? String { return s.isEmpty ? nil : s }
        if let n = x as? NSNumber { return n.stringValue }
        return nil
    }

    var role: String { str("AXRole") ?? "?" }
    var kids: [AXUIElement] { (v["AXChildren"] as? [AXUIElement]) ?? [] }
    var enabled: Bool { (v["AXEnabled"] as? Bool) ?? true }
    var isFocused: Bool { (v["AXFocused"] as? Bool) == true }
    var secure: Bool { str("AXSubrole") == "AXSecureTextField" }

    /// The words a person would use for this control, taken ONLY from attributes that describe
    /// it. AXValue is deliberately left out: a text field's value changes as someone types, a
    /// checkbox's flips when pressed, a pop-up's follows the selection. A name built from the
    /// value would change under the very action being verified, and the control would stop
    /// being findable the moment it was used.
    var ownName: String? {
        for k in ["AXTitle", "AXDescription", "AXLabel", "AXPlaceholderValue", "AXHelp"] {
            if let s = str(k)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        return nil
    }

    /// The app's own handle for a control, when it publishes one. Never folded into the name:
    /// identifiers are often internal strings like "_NS:237" and must not match what a person said.
    var identifier: String? {
        guard let s = str("AXIdentifier") ?? str("AXDOMIdentifier") else { return nil }
        // Generated identifiers change from launch to launch, so they identify nothing.
        return s.hasPrefix("_NS:") ? nil : s
    }

    /// Where a control is on screen in global coordinates, or nil when it has no size, which is
    /// how the tree says something is not currently drawn.
    var frame: [String: Int]? {
        guard let p = v["AXPosition"], let s = v["AXSize"],
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero, sz = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &pt)
        AXValueGetValue(s as! AXValue, .cgSize, &sz)
        if sz.width < 1 || sz.height < 1 { return nil }
        return ["x": Int(pt.x), "y": Int(pt.y), "w": Int(sz.width), "h": Int(sz.height)]
    }
}

/// The text a row or cell keeps in a descendant instead of on itself. A sidebar row publishes
/// no title; the words a person reads live in a child static text. Shallow on purpose: a row's
/// label is close to it, and walking deeper starts pulling in whatever the row opens.
func descendantText(_ p: Props, _ depth: Int = 3) -> String? {
    if depth <= 0 { return nil }
    for k in p.kids {
        let kp = Props(k)
        if kp.role == "AXStaticText", let s = kp.str("AXValue") ?? kp.ownName { return s }
        if kp.role == "AXTextField", !kp.secure, let s = kp.ownName { return s }
        if let deeper = descendantText(kp, depth - 1) { return deeper }
    }
    return nil
}

/// Name and where it came from. One function, used by both snap and act, so the name act
/// checks is by construction the name snap reported.
func nameOf(_ p: Props) -> (String?, String?) {
    if let n = p.ownName { return (n, nil) }
    if let b = descendantText(p) { return (b, "descendant") }
    // A role description is a real name when it says more than the role does. "close button"
    // is what a person would call it; a bare "button" repeats the role and is worth nothing.
    let bare = p.role.replacingOccurrences(of: "AX", with: "").lowercased()
    if let rd = p.str("AXRoleDescription") {
        let t = rd.trimmingCharacters(in: .whitespaces).lowercased()
        if !t.isEmpty && t != bare { return (rd, "roledesc") }
    }
    return (nil, nil)
}

// ---------------------------------------------------------------- app and windows

func runningApps() -> [NSRunningApplication] {
    // Accessory apps too: menu-bar utilities and Electron apps started from a terminal report
    // .accessory and would otherwise be invisible.
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited && $0.localizedName != nil }
}

func resolveApp() -> NSRunningApplication {
    if let pid = (req["pid"] as? NSNumber)?.int32Value {
        if let a = NSRunningApplication(processIdentifier: pid) { return a }
        fail("no_app", "no running app has pid \(pid)")
    }
    if let name = req["app"] as? String, !name.isEmpty {
        let want = name.lowercased()
        let apps = runningApps()
        if let hit = apps.first(where: { ($0.localizedName ?? "").lowercased() == want }) { return hit }
        if let hit = apps.first(where: { ($0.bundleIdentifier ?? "").lowercased() == want }) { return hit }
        if let hit = apps.first(where: { ($0.localizedName ?? "").lowercased().contains(want) }) { return hit }
        fail("no_app", "\(name) is not running. Open apps: " + apps.filter { $0.activationPolicy == .regular }
            .compactMap { $0.localizedName }.sorted().joined(separator: ", "))
    }
    guard let front = NSWorkspace.shared.frontmostApplication else { fail("no_app", "no app is in front") }
    return front
}

let running = resolveApp()
let appName = running.localizedName ?? "?"
let appEl = AXUIElementCreateApplication(running.processIdentifier)
// The unlock for Electron and Chromium, which report no windows without it. Harmless on
// native apps, so unconditional.
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

func windows() -> [AXUIElement] {
    if let w = attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !w.isEmpty {
        // Some apps list a title-bar-sized sliver first. Focused window first, then by area,
        // so the first window is the one the person is looking at.
        func area(_ x: AXUIElement) -> Double {
            var sz = CGSize.zero
            if let s = attr(x, kAXSizeAttribute as String) { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
            return Double(sz.width * sz.height)
        }
        let focused = attr(appEl, kAXFocusedWindowAttribute as String).map { unsafeBitCast($0, to: AXUIElement.self) }
        return w.sorted { a, b in
            if let f = focused { if CFEqual(a, f) { return true }; if CFEqual(b, f) { return false } }
            return area(a) > area(b)
        }
    }
    // Chromium sometimes publishes its window only as AXFocusedWindow at first.
    if let w = attr(appEl, kAXFocusedWindowAttribute as String) { return [unsafeBitCast(w, to: AXUIElement.self)] }
    return []
}

/// Window indices reorder the moment anything opens, raises or closes, so a path can silently
/// point at a different document than it did a second ago. "window" matches by title instead,
/// and is the safe way to address one window of a multi-window app.
func roots() -> [AXUIElement] {
    let all = windows()
    if all.isEmpty { fail("no_window", "\(appName) has no windows open") }
    guard let want = req["window"] as? String, !want.isEmpty else { return all }
    let t = want.lowercased()
    let hits = all.filter { (str($0, kAXTitleAttribute as String) ?? "").lowercased().contains(t) }
    if hits.isEmpty {
        fail("no_window", "no \(appName) window titled like \"\(want)\". Open windows: " +
             all.map { str($0, kAXTitleAttribute as String) ?? "(untitled)" }.joined(separator: " | "))
    }
    return hits
}

func windowTitle(_ rs: [AXUIElement]) -> String {
    // Taken from an actual window. Some apps publish a non-window first (a desktop scroll area
    // with no title); an empty title here would make every navigation that changes only the
    // title look like nothing happened.
    rs.first(where: { role($0) == "AXWindow" && str($0, kAXTitleAttribute as String) != nil })
        .flatMap { str($0, kAXTitleAttribute as String) } ?? rs.compactMap { str($0, kAXTitleAttribute as String) }.first ?? ""
}

let ACTIONABLE: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXLink", "AXSlider",
    "AXDisclosureTriangle", "AXIncrementor", "AXTab", "AXRow", "AXCell", "AXMenuItem",
]
let STRUCTURAL: Set<String> = ["AXToolbar", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXOutline",
                               "AXTable", "AXTabGroup", "AXList"]

// ---------------------------------------------------------------- snap

if cmd == "snap" {
    let depth = int("depth", 40, max: 80)
    // Breadth-first and capped. Measured: 50 controls cost 234ms, 100 cost 882ms, 300 cost
    // 2328ms, superlinear. The shallow controls (toolbar, sidebar, chrome) are the ones people
    // name; the deep tail is file rows. A list of 300 is also not something anyone can choose from.
    let cap = int("limit", 120, max: 500)
    let textCap = int("texts", 60, max: 300)
    let valueMax = int("valueMax", 200, max: 100_000)
    let rs = roots()
    var out: [[String: Any]] = []
    var texts: [String] = []
    var seenText = Set<String>()
    // Each entry carries the name of its nearest named ancestor, so a nameless button in a named
    // toolbar is still "the button in the toolbar". Elements go in and Props come out at the far
    // end, so a node dequeued after the cap is never read.
    var queue: [(AXUIElement, String, Int, String)] = rs.enumerated().map { ($0.element, "/\($0.offset)", 0, "") }
    var head = 0, visited = 0
    while head < queue.count && out.count < cap {
        let (el, path, d, container) = queue[head]; head += 1
        visited += 1
        if visited > 20000 { break }
        let p = Props(el)
        let r = p.role
        if ACTIONABLE.contains(r) {
            var row: [String: Any] = ["path": path, "role": r, "enabled": p.enabled]
            let (name, by) = nameOf(p)
            if let n = name { row["name"] = clip(n, 120) }
            if let b = by { row["namedBy"] = b }
            if let id = p.identifier { row["identifier"] = id }
            if let sr = p.str("AXSubrole") { row["subrole"] = sr }
            if !container.isEmpty { row["container"] = container }
            if let f = p.frame { row["frame"] = f }
            if p.isFocused { row["focused"] = true }
            // A secure field's contents are never read out, even when the app would allow it.
            if p.secure { row["secure"] = true }
            else if let v = p.str("AXValue") { row["value"] = clip(v, valueMax) }
            out.append(row)
        } else if r == "AXStaticText", texts.count < textCap, let t = (p.str("AXValue") ?? p.ownName)?
                    .trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !seenText.contains(t) {
            // What the screen says, as distinct from what can be pressed. A calculator's display
            // is static text; without it, pressing "7" would change nothing that was observed and
            // a press that worked would be reported as a miss.
            seenText.insert(t)
            texts.append(clip(t, 200))
        }
        if d < depth {
            // A named non-actionable node becomes the container its descendants report, except
            // the window itself: "in the window" locates nothing. An unnamed structural node
            // contributes its role, which still tells one region of a window from another.
            var next = container
            if !ACTIONABLE.contains(r) && d > 0 && r != "AXWindow" {
                if let n = p.ownName { next = clip(n, 60) }
                else if STRUCTURAL.contains(r) { next = r.replacingOccurrences(of: "AX", with: "").lowercased() }
            }
            for (j, k) in p.kids.enumerated() { queue.append((k, "\(path)/\(j)", d + 1, next)) }
        }
    }
    emit([
        "app": appName, "pid": running.processIdentifier, "front": running.isActive,
        "window": windowTitle(rs), "elements": out, "texts": texts,
        // Said out loud, so a caller never mistakes a capped list for the whole window.
        "truncated": head < queue.count,
    ])
    exit(0)
}

// ---------------------------------------------------------------- act

if cmd == "act" {
    guard let path = req["path"] as? String else { fail("bad_request", "act needs a path") }
    let kind = req["kind"] as? String ?? ""
    let rs = roots()
    let idx = path.split(separator: "/").compactMap { Int($0) }
    guard let first = idx.first, first < rs.count else { fail("not_found", "no element at \(path)") }
    var cur = rs[first]
    for n in idx.dropFirst() {
        let ks = (attr(cur, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
        guard n < ks.count else { fail("not_found", "no element at \(path); the window changed") }
        cur = ks[n]
    }
    let p = Props(cur)
    // The path came from an observation that may already be stale. Check that the element here
    // is still the one meant, by role and by name, before touching it. A path is a property of
    // one observation, not of a control, and acting on a path that now points elsewhere is how
    // an agent types confidently into the wrong field.
    if let want = req["role"] as? String, p.role != want {
        fail("moved", "the element at \(path) is now a \(p.role), not a \(want); nothing was done")
    }
    let (name, _) = nameOf(p)
    if let want = req["name"] as? String, clip(name ?? "", 120) != want {
        fail("moved", "the element at \(path) is now \"\(name ?? "nameless")\", not \"\(want)\"; nothing was done")
    }
    if !p.enabled { fail("disabled", "\"\(name ?? p.role)\" is disabled right now; nothing was done") }

    var out: [String: Any] = ["path": path, "role": p.role, "app": appName, "kind": kind]
    var err: AXError = .success

    func focus() -> AXError { AXUIElementSetAttributeValue(cur, kAXFocusedAttribute as CFString, kCFBooleanTrue) }

    /// Keystrokes go to the target process, not to whatever is frontmost, so they cannot land in
    /// another app if the person switches windows mid-action.
    func post(_ key: CGKeyCode, _ flags: CGEventFlags, unicode: [UniChar]? = nil) -> Bool {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { return false }
        down.flags = flags; up.flags = flags
        if var u = unicode {
            down.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
            up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        }
        down.postToPid(running.processIdentifier)
        usleep(2000)
        up.postToPid(running.processIdentifier)
        usleep(2000)
        return true
    }

    switch kind {
    case "press":
        // AXPress is the app's own handler, so it works on elements a synthetic click at a
        // point would miss (scrolled out of view, behind an overlay).
        err = AXUIElementPerformAction(cur, kAXPressAction as CFString)
        for alt in ["AXConfirm", "AXPick", "AXOpen"] where err != .success {
            err = AXUIElementPerformAction(cur, alt as CFString)
        }
        // Rows and cells publish no press action: selecting them is how they are activated.
        if err != .success, ["AXRow", "AXCell"].contains(p.role),
           AXUIElementSetAttributeValue(cur, "AXSelected" as CFString, kCFBooleanTrue) == .success {
            err = .success
            out["via"] = "selected"
        }
    case "set":
        guard let v = req["value"] as? String else { fail("bad_request", "set needs a value") }
        // Assigning AXValue is atomic and needs no focus, so it cannot interleave with whatever
        // the person is typing at the time. When a control refuses it, say so; the caller can
        // choose "type" knowingly rather than have this quietly switch to keystrokes.
        err = AXUIElementSetAttributeValue(cur, kAXValueAttribute as CFString, v as CFTypeRef)
    case "focus":
        err = focus()
    case "type":
        guard let v = req["value"] as? String else { fail("bad_request", "type needs a value") }
        err = focus()
        if err == .success {
            let units = Array(v.utf16)
            // Chunked: one event carries at most about 20 UTF-16 units reliably.
            var i = 0
            while i < units.count {
                let chunk = Array(units[i..<min(i + 20, units.count)])
                if !post(0, [], unicode: chunk) { err = .failure; break }
                i += 20
            }
        }
    case "key":
        let keys: [String: CGKeyCode] = [
            "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "escape": 53,
            "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
        ]
        guard let k = req["key"] as? String, let code = keys[k.lowercased()] else {
            fail("bad_request", "key must be one of " + keys.keys.sorted().joined(separator: ", "))
        }
        var flags: CGEventFlags = []
        for m in (req["modifiers"] as? [String]) ?? [] {
            switch m.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "control", "ctrl": flags.insert(.maskControl)
            default: fail("bad_request", "unknown modifier \(m)")
            }
        }
        err = focus()
        if err == .success && !post(code, flags) { err = .failure }
    default:
        fail("bad_request", "kind must be press, set, focus, type or key")
    }

    // "acted" means only that the app accepted the message. It is not evidence that anything
    // happened; the caller must observe again to find out. The helper reporting success on an
    // accepted AXPress, even beside an error, is the exact failure this design exists to remove,
    // so the flag is tied to the error and nothing else.
    out["acted"] = (err == .success)
    if err != .success { out["axError"] = Int(err.rawValue) }
    emit(out)
    exit(0)
}

fail("bad_request", "unknown command \"\(cmd)\" (trust, snap, act)")
