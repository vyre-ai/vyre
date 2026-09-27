// vyre-tile: moves and sizes other apps' windows for the side view, through the accessibility API.
//
// One request per run: a JSON line on stdin, one JSON line on stdout, exit. Nothing stays alive
// between side view calls, so an idle side view costs nothing. Requests go over stdin rather than
// argv because argv is readable by every process through `ps`.
//
// All frames are in accessibility coordinates: points, origin at the top left of the main
// display, y growing down. NSScreen's frames are converted into the same space here, so the
// caller does its layout math in one coordinate system.
//
//   {"cmd":"trust","prompt":false}              whether this process may use accessibility
//   {"cmd":"frames","bundles":[..],"pids":[..]} the front app, the screens, and the standard
//                                                windows of those apps, front to back
//   {"cmd":"set","moves":[{pid,index,title,frame}],"activate":[pid,..]}
//                                                apply frames in order and report the frames
//                                                the windows actually took
//
// It never synthesizes keyboard or mouse input. The only prompt it can raise is the
// accessibility one, and only when the caller asks for it and dialogs are allowed.

import Cocoa
import ApplicationServices

func emit(_ obj: [String: Any]) -> Never {
    var d = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
    d.append(0x0A)
    FileHandle.standardOutput.write(d)
    exit(0)
}

func fail(_ code: String, _ msg: String) -> Never { emit(["error": msg, "code": code]) }

/// The same rule as core/config/dialogs.js, as far as a helper can see it from its environment.
func dialogsAllowed() -> Bool {
    let env = ProcessInfo.processInfo.environment
    if env["VYRE_NO_DIALOGS"] == "1" { return false }
    if env["VYRE_CAPSULE_TEST"] != nil { return env["VYRE_TEST_DIALOGS"] == "1" }
    if env["NODE_TEST_CONTEXT"] != nil { return env["VYRE_TEST_DIALOGS"] == "1" }
    return true
}

func rectDict(_ r: CGRect) -> [String: Any] {
    ["x": Double(r.origin.x.rounded()), "y": Double(r.origin.y.rounded()), "w": Double(r.size.width.rounded()), "h": Double(r.size.height.rounded())]
}

func rectFrom(_ o: Any?) -> CGRect? {
    guard let d = o as? [String: Any], let x = d["x"] as? Double, let y = d["y"] as? Double,
          let w = d["w"] as? Double, let h = d["h"] as? Double, w > 0, h > 0 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

/// NSScreen space (origin bottom left of the main display) to accessibility space.
func toAX(_ r: CGRect) -> CGRect {
    let mainH = NSScreen.screens.first?.frame.height ?? 0
    return CGRect(x: r.minX, y: mainH - r.maxY, width: r.width, height: r.height)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frameOf(_ win: AXUIElement) -> CGRect? {
    guard let p = attr(win, kAXPositionAttribute), let s = attr(win, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}

func windows(_ pid: pid_t) -> [AXUIElement] {
    (attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

/// Front-to-back order of on-screen windows, as (pid, bounds). Owner and bounds need no grant.
func zOrder() -> [(pid: pid_t, bounds: CGRect)] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { w in
        guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
        return (pid_t(pid), r)
    }
}

func near(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
}

let line = readLine(strippingNewline: true) ?? ""
guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let cmd = req["cmd"] as? String else { fail("bad_request", "one JSON request line with a cmd is expected on stdin") }

switch cmd {
case "trust":
    let prompt = (req["prompt"] as? Bool ?? false) && dialogsAllowed()
    let trusted = prompt
        ? AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        : AXIsProcessTrusted()
    emit(["trusted": trusted, "prompted": prompt])

case "frames":
    guard AXIsProcessTrusted() else { fail("not_trusted", "this process is not allowed to use the accessibility API") }
    let bundles = Set((req["bundles"] as? [String]) ?? [])
    let pids = Set(((req["pids"] as? [Int]) ?? []).map { pid_t($0) })
    let front = NSWorkspace.shared.frontmostApplication
    let screens = NSScreen.screens.map { ["frame": rectDict(toAX($0.frame)), "visible": rectDict(toAX($0.visibleFrame))] }
    let z = zOrder()
    var out: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
        let b = app.bundleIdentifier ?? ""
        // By bundle, only apps with a Dock icon; by pid, whatever the caller named (a test's own
        // accessory window).
        guard (bundles.contains(b) && app.activationPolicy == .regular) || pids.contains(app.processIdentifier) else { continue }
        for (i, w) in windows(app.processIdentifier).enumerated() {
            guard let f = frameOf(w) else { continue }
            let sub = attr(w, kAXSubroleAttribute) as? String
            let rank = z.firstIndex { $0.pid == app.processIdentifier && near($0.bounds, f) }
            out.append([
                "pid": Int(app.processIdentifier), "bundle": b, "app": app.localizedName ?? b, "index": i,
                "title": (attr(w, kAXTitleAttribute) as? String) ?? "", "frame": rectDict(f),
                "minimized": (attr(w, kAXMinimizedAttribute) as? Bool) ?? false,
                "standard": sub == nil || sub == (kAXStandardWindowSubrole as String),
                "z": rank ?? 100_000,
            ])
        }
    }
    var frontDict: [String: Any] = [:]
    if let f = front { frontDict = ["pid": Int(f.processIdentifier), "bundle": f.bundleIdentifier ?? "", "app": f.localizedName ?? ""] }
    emit(["front": frontDict, "screens": screens, "windows": out])

case "set":
    guard AXIsProcessTrusted() else { fail("not_trusted", "this process is not allowed to use the accessibility API") }
    var results: [[String: Any]] = []
    for m in (req["moves"] as? [[String: Any]]) ?? [] {
        guard let pidN = m["pid"] as? Int, let idx = m["index"] as? Int, let target = rectFrom(m["frame"]) else {
            fail("bad_request", "each move needs pid, index and frame")
        }
        let pid = pid_t(pidN)
        let wins = windows(pid)
        var win: AXUIElement? = idx < wins.count ? wins[idx] : nil
        // An index can shift when the app opens or closes a window between calls; the title is
        // the tie-breaker.
        if let t = m["title"] as? String, !t.isEmpty, let w = win, (attr(w, kAXTitleAttribute) as? String) != t {
            win = wins.first { (attr($0, kAXTitleAttribute) as? String) == t }
        }
        guard let w = win else { results.append(["pid": pidN, "index": idx, "ok": false, "code": "gone"]); continue }
        if (attr(w, kAXMinimizedAttribute) as? Bool) == true {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
        var pos = target.origin, size = target.size
        let pv = AXValueCreate(.cgPoint, &pos)!, sv = AXValueCreate(.cgSize, &size)!
        // Position, size, position: a window moving to another display is clamped to the old
        // one's size limits otherwise, and a shrink can push it back off its origin.
        AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pv)
        let sizeErr = AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, sv)
        AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pv)
        let actual = frameOf(w) ?? target
        results.append(["pid": pidN, "index": idx, "ok": sizeErr == .success, "frame": rectDict(actual), "exact": near(actual, target)])
    }
    // Bring the tiled apps forward, last one on top and holding the keyboard. activate is an
    // app-level request macOS may decline; it is not synthetic input.
    for p in (req["activate"] as? [Int]) ?? [] {
        NSRunningApplication(processIdentifier: pid_t(p))?.activate()
    }
    emit(["results": results])

default:
    fail("bad_request", "unknown command \(cmd)")
}
